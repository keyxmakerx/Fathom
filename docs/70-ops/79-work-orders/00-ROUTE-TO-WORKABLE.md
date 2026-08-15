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
| Module size | **852,918 bytes against a 900,000-byte ceiling that fails the merge (re-measured 2026-08-11, after the hand-authoring commits)** |

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
**Depends on:** one owner act — approving the two crypto crates (ADR-0032, §5). **No longer depends
on stage 1's ceiling decision.** **Size:** days, page-side.

> **REWRITTEN 2026-08-11, after a six-way survey each finding of which was adversarially verified.**
> The paragraph this replaces was not wrong about its number and was wrong about the feature. It
> priced **saving the expanded model**, which is the one shape of persistence that does not fit. See
> §5b below for the route that does, why it is also the better one, and what it still needs.

The snapshot route is real, green, and too big. A verifier independently ran ingest → weld →
`write_plain` → `read_plain` → `write_plain` on the SRX fixture, byte-identical; `fathom-workspace`
is 767 lines with zero external dependencies and 11 passing tests. **Linking it re-measured at
+235,926 bytes** (852,918 → 1,088,844), which fails `artifact_gates.rs`'s ceiling assertion in CI.
Splitting it does not rescue it: **save alone is already 45,976 bytes over the ceiling.**

Three further facts, each measured, that settle the shape rather than the size:

- **None of that 239 KB is cryptography.** `fathom-workspace/src/lib.rs:16` says so in terms —
  *"There is no cryptography here, and no integrity field, on purpose"*. The cost is the snapshot
  machinery: `Graph::from_snapshot` alone is 110,256 bytes, 47% of the whole round trip.
- **The decided crypto stack is cheap and fits today.** Argon2id v1.3 + ChaCha20-Poly1305 (`32` D1,
  D3) measured at **+36,590 bytes** against 47,082 of headroom, and adds **no wasm import** — the
  host hands in salt and nonce exactly as `OP_PASTE` already hands in clock and entropy.
- **The snapshot format is the more fragile one.** `lib.rs:182` refuses outright on any
  `SCHEMA_VERSION` difference, with no migration. A file saved today stops opening the next time the
  schema moves.

Two things ride along at zero wasm cost: the unsaved-change count plus `beforeunload` that `43` §3.8
already specifies and which greps to zero in the page, and a test round-tripping an `Origin::Parsed`
graph — a wire form no test in the repository touches.

### Stage 5b — Save the journal, not the model

**The route. +263 bytes of module, and it is also the better design.**

Save **what the operator did** — the redacted config text they pasted, each piece of equipment they
added, each field they corrected, each thing they removed — and replay it on open. Do not save the
expanded model those acts produced.

Every op it needs already exists and is already linked: `OP_PASTE`, `OP_EQUIP_ADD`, `OP_FIELD_SET`,
`OP_ELEMENT_REMOVE`. The page composes those frames today and throws them away. Replay is
byte-identical because the module is deterministic given the host's clock and entropy, which the
frames already carry by design (invariant 9 is what makes this work, not what it fights).

| | Snapshot | Journal |
|---|---|---|
| Module cost | +235,926 — over the ceiling by 188,844 | **+263** |
| File size, same estate | 33,840 bytes | **2,406 bytes** |
| A schema change | file stops opening (`lib.rs:182`, no migration) | re-derives |
| Real-time collaboration | *"state written beside the op log"* — `75` §2.4's named failure | **it is an op log** |

**Measured end to end, as one build rather than by adding deltas: the redacted-capture opcode plus
Argon2id plus ChaCha20-Poly1305 lands at 889,723 bytes against the 900,000 ceiling** — 10,277 to
spare, import section still empty. So the ceiling decision (`§2` stage 1, Route D) is **not**
required for this feature. Keep that decision for the dictionary and corpus question, which does
need it.

`75` §2.4 is worth reading directly here, because the cheap route and the future-proof route turn
out to be the same one: *"The op log is what a future CRDT converges; state written beside it
instead of through it is state that multi-writer collaboration can never carry."*

#### The gate that makes this safe, and the four honest costs

**INVARIANT 3 IS A HARD GATE ON THIS ROUTE.** A journal of the **raw** paste would send
pre-shared-key text to the encryptor and into the operator's sync folder. The journal must carry
`IngestOutput.capture` — the text the redaction gate produces — and never the raw paste. This was
tested rather than argued: replaying the redacted capture yields the same 13 nodes, and of 99
differing lines between the two snapshots **all 99 are byte-span offsets and none is semantic**
(the offsets shift because the redacted text is 3 bytes shorter, and they are correct as shifted,
because they point into the text that is actually stored). Re-ingesting redacted text is idempotent.
The work order carries this as a gate with a canary test, or the cheapest route becomes the one that
leaks a pre-shared key into Dropbox.

1. **Replay time grows with the journal.** 3.4 ms for three ops. A multi-year journal needs periodic
   compaction to a checkpoint — the same thing a CRDT would do.
2. **Source-span highlighting points into the redacted text**, so it shifts a few bytes from the
   original paste. That is the honest behaviour, and it should be stated in the UI rather than fixed.
3. **An old journal replayed through a NEWER dictionary binds statements it previously could not**,
   producing a *richer* estate and shifting minted ids. Mostly a feature; must be surfaced, never
   silent. It needs its own test.
4. **`showSaveFilePicker` is Chromium-only, and that is permanent.** Measured in a real browser,
   from a `file://` page: Chrome/Edge open the native dialog, write to a chosen folder, persist the
   handle in IndexedDB and re-save after a refresh with **no** re-prompt — so `file://` *is* a secure
   context and the widely repeated claim that the picker throws there is false for Chromium.
   **Mozilla's standards position records the local-disk pickers as *harmful*, so this is a decision
   rather than a backlog item** (MDN *showSaveFilePicker* — *"Limited availability… not Baseline
   because it does not work in some of the most widely-used browsers"*; Mozilla standards positions;
   both checked 2026-08-11).

   **The owner uses Firefox, so this is the deployment reality and not a footnote.** §4.9 below is
   the Firefox route, and it is workable rather than a degradation to apologise for.

#### 4.9 The Firefox route — one extra click, not a different product

**Added 2026-08-11. The owner asked directly: *"what is the solution for Firefox users like me? Or
is this basically chrome only until we move to database hosted?"* The answer is no on both counts.**

**Opening never needed the picker.** `<input type="file">` is universal and has been for twenty
years. So *reading* a workspace works identically in every browser, on every platform, including
mobile. Only the write side differs at all.

**Writing on Firefox is `<a download>` plus one Firefox setting.** With **Settings → General →
Downloads → "Always ask you where to save files"** turned on (`browser.download.useDownloadDir` =
`false`), Firefox opens a native save dialog for every download — so the operator picks the folder,
including a synced one, on each save. Without it, every save lands silently in the Downloads folder
and numbers itself `fathom(1).fathom`, which is the bad experience people describe.

That is one dialog per save, against Chromium's zero. It is worth being exact about how much that
actually costs here, because it is less than it sounds:

- **Save is explicit, never automatic.** There is no autosave to fight; the dialog appears when the
  operator asks to save, which is the moment they already expect one.
- **The journal is ~2.4 KB.** Writing is instant, so the dialog is the whole cost.
- **The one real loss is silent overwrite.** Firefox will ask to replace rather than replacing
  quietly, and the page cannot confirm the save happened. So the unsaved-change indicator must be
  driven by *"you asked to save"*, not by *"the write succeeded"*, and it must say so honestly.

**Firefox extensions that add the API are refused.** They exist. Asking the operator of a
security-first tool to install a third-party extension that grants disk access, in order to use the
tool, inverts the product's entire posture.

#### 4.10 The file is a bridge — the destination is a database on the owner's own server

**CORRECTED 2026-08-11 by the owner, and the correction is right.** This section previously argued
that server-hosted storage *"does not solve this and is a different decision"*. His answer:

> *"No it having the database be local to the server will fix it, then there is no local client
> solution… eventually when I have a private server on the corps network and hardware that is
> secured we won't need this local database solution. This part is temporary only."*

If the estate lives in a database on his server, the browser stores nothing, no file is written, no
picker is needed, and **§4.9's whole Chromium-versus-Firefox problem ceases to exist**. The earlier
analysis judged the server route against *"does it give him a folder of his choosing"* — a
requirement he had stated an hour before — and missed that the folder was a means, not the end. See
`70` §17 for the full record.

**What this changes about the plan: essentially nothing, and that is the point.** §5b saves the
operator's **ops**, and an op log is exactly what a client sends to a server — small, ordered,
append-only, self-describing. The 2.4 KB file today becomes the request body tomorrow, and the file
becomes one *transport* rather than the design. The snapshot route would not have survived this
correction at all: a serialised graph blob is a client-side storage format and nothing else.

**One change of emphasis:** do not over-invest in the file. It must work, be encrypted and be
openable. It does **not** need versioning, compaction, merge, or a sync-conflict story — those are
the server's problems and the server is coming. (This retires cost #1 above as a near-term concern.)

**Two things this forces, both owner decisions, neither an execution matter:**

1. **Invariant 1 must be reopened on merit.** *"It never connects to anything"* and *"the page reads
   its estate from a server"* cannot both hold. `75` §2 records the owner's own instruction that sunk
   cost never argues for keeping a decision, and `38` exists to price exactly this — but it is an ADR,
   never a quiet implementation detail. **Invariant 2 is untouched**: Fathom still never logs into a
   device, and a server for the operator's own records does not weaken that at all.
2. ~~**Can the server read the estate?**~~ **CORRECTED 2026-08-15: this was not an open question and
   the dichotomy was false.** The owner answered it himself in `70` §8 on 2026-08-10 — *"Server-side
   search or querying over the estate: **Never.**"* — and `41` §5.5 enforces it in the linker.
   Multiuser accounts, 2FA, SMTP reset, sharing and an administrative panel **all work on a server
   that cannot read an estate**; only cross-estate search, admin content-reading and server-side
   reporting need plaintext. `70` §17.5 is the corrected analysis and carries the narrower question
   that genuinely remains.

**Sequence, therefore, unchanged: journal → encrypt → save. What changes is that the save is
explicitly a bridge, and the server is the destination rather than an alternative.**

#### What is refused, and why

- **Browser storage — `localStorage`, `IndexedDB` for data — is banned by a decision of record** and
  enforced by a canary that requires the origin's storage to be *empty*, not merely free of
  plaintext. It is the obvious "just stop the bleeding" move and it is forbidden.
- **Plaintext first, encryption later** buys days, not weeks — encryption is +36,590 bytes and
  already fits — and it costs a window in which the operator's topology, addressing and hostnames sit
  unencrypted in a sync folder. Against `70`'s stated priority order, security first. Refused.
- **WebCrypto in the page** is not the shortcut it looks like: `32` D3 already rejected AES-GCM via
  `crypto.subtle` precisely because it means moving plaintext into the JS heap. The decided stack
  stays in the module.

#### The one thing that needs the owner

ADR-0032 §5: per-crate approval is **an owner act and may not be delegated to a planning session**,
and a work order naming a crate without a matching approval record is malformed under `78` §8. The
crypto stack needs the project's first two external dependencies. **Gate zero in `ci.yml` — the
three-line check that fails when `Cargo.lock` gains an unapproved package — must land before they
do**, per ADR-0032 §6, and it still does not exist.

So the sequence is: gate zero, then the owner's approval of the two crates, then the work order.
Everything else in 5b is unblocked.

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

## 4b. The stage this route omitted: hand authoring

**Added 2026-08-11, from a six-way survey each finding of which was adversarially verified.** The
owner asked how he adds a device without pasting a config — *"drag a device then I can in its
inventory set the device type model and other info"*. The honest answer is that this route document,
`00-INDEX.md` and `00-PROGRAM-PLAN.md` between them contain **zero** occurrences of `drag`,
`hand author`, `create a node`, `stencil` or `quick-create`. The capability was never priced.

It should have been, because it is agreed at the founding-document level and because half of it is
the cheapest real feature left in the tree.

**What is agreed.** Hand entry is one of the three provenance origins in the owner's own brief;
`Origin::Hand` is the *first* variant of the enum (`fathom-graph/src/prov.rs:64`). `52` §3.6 line 432
states the diagram's job as *"add a device, draw a link, draw a tunnel, drag for layout"*. `75` §10
carries it as capability **C-08**, from the owner verbatim, status *Intent recorded* — and §10.4's
heading is already the finding: *"What is missing is the affordance, not the machinery."*

**What is measured.** Three numbers, each from running code rather than reading it:

| | |
|---|---|
| The store's mutation API | **Complete.** `insert_node`, `insert_edge`, `set_field`, `clear_field`, `tombstone`, batches — all public. A probe built a Device with a hostname and a model through it, with no config text anywhere. |
| The one missing primitive | **~28 lines.** `set_field<T: Any>` compares `TypeId::of::<T>()` against the schema, so a *byte* protocol can never call it. `Graph::from_snapshot` already installs erased values by building the `pub(crate)` `Slot` directly. A `set_field_boxed` beside `set_field` closes it; written as a probe, it works. |
| The wasm cost of the create-and-edit slice | **+5,677 bytes** against 72,971 of headroom. |

**The architecture decision inside it, which must be recorded before anyone starts.** There are two
routes from typed text to a stored value, and one of them fails the merge:

- **Route A — reuse the generated 299-arm `slot_from_canon` table.** Every field of every kind
  becomes writable with no new dispatch. **Measured at +107,857 bytes: the module goes to 934,886 and
  breaches the ceiling by 34,886.** It is the obvious answer and it is refused.
- **Route B — a narrow `TypeId` dispatcher** over only the scalars a Device/Chassis/Interface form
  needs, each parsed with `Scalar::parse`. **+5,677 bytes.** It is the mirror image of the
  `render_set` table that already exists in `fathom-inventory/src/render.rs:148-281`, and the two
  belong side by side so they cannot drift apart.

**Where it belongs.** On this document's own ordering principle (§3, *cheap-and-load-bearing first,
then visible*): immediately after stage 4 and **before** stage 5. It costs 5,677 bytes; persistence
costs 239,964.

**What the slice is not.** Three separations worth keeping straight, because the owner's sentence
contains all three and they differ by orders of magnitude:

1. **Create and edit** — the above. Days.
2. **Drag on a canvas** — needs the diagram view, which does not exist in the product *or* in the
   prototype (`design/prototype/fathom-app.html:2001` states its own constraint: *"computed layout,
   never hand-placed coordinates"*). Stage 8, months. Note also that **there is nowhere in `schema/`
   to store where a box sits**; `56` §3.5's `LayoutHint` is prose in a design doc, and it may
   deliberately belong outside the typed graph as a view preference. Undecided, and a dragged box
   cannot survive a reload until it is.
3. **Emit a config from it** — the emitter is already provenance-blind: `fathom-emit`'s flagship test
   builds its whole graph by hand with `Origin::Hand`, touches no parser, and matches a 21-line
   golden byte-for-byte. But its only `EmitScope` variant is `IpsecVpn`; a Device returns
   `NotAnIpsecVpn`, and **no crate in the workspace depends on `fathom-emit` at all**. `11` §9.2
   already specifies the `Device` emit unit as *"whole config"*. That is WO-04 §10 item 5, unwritten.

**One thing genuinely needs the owner**, and it is small: `Device` has twelve fields and **`model` is
not one of them** — `model` lives on `Chassis` (`schema.yaml:219`), which every Device owns by
declaration (`HasChassis`, `out: "1..n"`). So "drag a device and set its model" is two nodes and an
edge. Does the gesture create the Chassis silently, or ask? `fathom_weld::containment_edge` already
computes the edge kind with nothing hand-written, so this is one line in a work order, not code.

Related and cheap: `Device.role` is the closest thing to "device type" and has five variants —
`firewall`, `router`, `switch`, `load_balancer`, `other`. No access point, no server. Adding a
variant is a minor bump. Adding a whole field was measured end to end: **two lines in `schema/`, one
generator run, three one-line test-constant edits, zero production Rust** — and the generator
*refuses* if the field-key registry entry is forgotten.

## 5. Disagreements with the program plan

1. **Persistence is not unblocked days of work.** `00-PROGRAM-PLAN.md` and the persistence audit
   both treat it so. It is hours of code behind a byte decision, measured at +239,964 bytes against
   72,971 of headroom.
2. **The program plan's tier 1 is overstated by 4×.** Its headline says *"the first five unblock
   more than the other twenty-nine combined"*; four of the five are already on disk.
3. **"Every owner decision the build waits on" includes several the build does not wait on.** §4
   lists them. The cost of a wrong entry is not neutral: it blocks a stage on an answer that is
   never coming.

## Failure modes

1. **The ceiling is decided as a number and bleeds.** 47,082 bytes of headroom against measured
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
| `cargo test -p fathom-wasm --test artifact_gates` (run 2026-08-11) | 827,029 bytes against the 900,000 ceiling |
| Direct reproduction of the estate-destruction defect, then its fix | §1's closing paragraph |
| `docs/70-ops/70-*.md` §16, `docs/70-ops/79-work-orders/00-PROGRAM-PLAN.md` §16 | The owner-decision split in §4 |
