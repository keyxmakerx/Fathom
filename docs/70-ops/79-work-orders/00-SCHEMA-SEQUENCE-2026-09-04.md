# 00 — The schema sequence: which decision lands on which version, and which keys it takes

> **Status:** Proposed, 2026-09-04 — planning's sequencing note for the queue, and operative for
> it from that date: **any planning session authoring a schema order from
> `RECOMMENDATIONS-2026-09-04.md` §8–§15 reads this first and takes its version and its field keys
> from §3, re-deriving nothing.** Written under `78` §7 as judgment-shaped work; it decides
> **sequencing and version arithmetic only** and decides the content of no decision — every
> decision below still waits on the owner's answer its own section names, and §4's *depends on*
> rows say which. Verified against the tree on 2026-09-04 (§9). Attacked once by a skeptic: every
> numeric and sequencing claim held; two prose defects were found and are applied (§1.3); one of
> the skeptic's own citations is wrong and is under *Disagreements*.
> **What it resolves:** `RECOMMENDATIONS-2026-09-04.md` *Failure modes* items 1, 2 and 3, and it
> reads item 4 for one ordering constraint. **What it is not:** an ADR, a work order, or an answer.
> Each landing below still needs its own record — ADR-0035, 0036 and 0037 each carried a schema
> bump in an ADR and WO-10 carried one in an order — and this note is not that record for any of
> them.

## 0. Contents

| § | |
|---|---|
| 1 | What this note decides, what it does not, and the rule it was read against |
| 2 | The three principles that fix the order, and the four constraints from the record |
| 3 | The landing order — one table |
| 4 | Each position: why here, what it depends on, what the counts are after it lands |
| 5 | The major-class bump: D3 at position 7, alone |
| 6 | The three cross-decision conflicts, resolved |
| 7 | The shift rule when a decision is refused |
| 8 | What each later order must change in its own section of the record |
| 9 | Verified against the tree, 2026-09-04 |
| — | Failure modes · Open decisions · Sources consulted · Disagreements |

---

## 1. What this note decides, what it does not, and the rule it was read against

### 1.1 The defect, verbatim

`RECOMMENDATIONS-2026-09-04.md` *Failure modes* item 1:

> Six of the eight schema decisions each name their bump "0.6", and three of them each start their
> field keys at 312. Groups-and-tags (0.6, keys 312–314), D3 (0.6, key 9 kept), D4 (0.6, keys
> 312–315), D5 (0.6, no keys), D6 (0.6, keys 312–361) and D7 (0.6, no keys) were designed in
> parallel and each priced itself alone. They cannot all be 0.6. Whichever lands first is 0.6; the
> rest renumber; field keys are assigned in landing order at the tail of `field-keys.yaml`, and
> every pinned count in this record (53 kinds, 99 edges, 314 keys; 361 keys; 100 containment pairs)
> is correct only for the decision landing alone on 0.5. D3 is major-class: if it lands in the same
> bump as any of the others, the whole bump is major-class and `62` §16.4's three requirements
> apply to all of it. Sequencing is a planning session's (`78` §7), and this record does not do it.

Items 2 and 3 of the same section name two more conflicts — the `Placeable` drift test (D5 against
groups-and-tags) and the counts D4 and D6 change in each other, plus the `Device.role` doc that D4
amends and D3 replaces. Item 4 — D1 and D3 meet at one missing control — is not a sequencing
conflict, but it fixes one ordering (§2.2).

### 1.2 The rule this was read against — `62` §16, read first and in full

`62` §16.2 is the normative bump table. The rows this note uses, quoted:

| Change to `schema/` | Bump |
|---|---|
| New node kind | minor |
| New edge kind | minor |
| New optional field | minor |
| New enum variant | minor |
| Relaxed constraint / widened cardinality upper bound / widened `from`/`to` set | minor |
| New identity tuple appended | minor |
| Field type changed | **major** |

`62` §16.2 also fixes the method: *"That arithmetic is the model for how every future change is
priced — against this table, item by item, in writing."* The file's own 0.2–0.5 version comments
(`schema/schema.yaml` lines 6–60, the `schema:` block, ending before `scalars:` at line 61) are that writing, one change per paragraph, and the 0.5
paragraph is the precedent for *"fields on a new declarer are minor by the same table"*.

`62` §16.4 names **one mechanism and three requirements**. The mechanism: `schema/released/`
holds one `schema.json` snapshot per released version and CI diffs against the latest, failing
`schema.version.bump-too-small` when the declared bump is smaller than the table requires. The
three requirements, which a major bump *additionally* carries: a written migration note, a
`Migration` impl registered in the chain, and a golden fixture for the outgoing version (`11`
§11.5). Where each stands for D3 is §5.

Three of the eight decisions have no row in that table and are priced by argument — D1 (a `doc:`
edit and, later, a platform-registry row), D5 (a new `layer` value; §11.1 proposes two rows), and
E4 (populating `emit_dict:` hooks). This note takes each record's own pricing (§15.5, §11.5,
§14.5) and adds nothing to the table; the table is `62`'s owner's (*Open decisions*).

### 1.3 What this note does not decide

- **Whether any decision lands.** Each waits on the owner's answer its own *Needs the owner* names
  (RECOMMENDATIONS *Open decisions*, *Data model*); D3 has no recorded answer at all
  (`OPEN-FOR-THE-OWNER.md` §D3, read 2026-09-04: a question and no answer under it). §4's
  *depends on* rows carry the gate for each position; §7 says what moves when one is refused.
- **The content of any decision.** In particular: whether `Group` and `Tag` ever leave
  `layer: config` (§6.2); whether `lifecycle` belongs on `Group`, `Tag` and `Fixture` (§4.6 — a
  stop-and-escalate in D6's order); D3's on-box rendering and its seven tick-boxes (§9.7); the
  rack move's reopening (§10.7).
- **Whether D3 declares 1.0.** §5 — a release decision.

Two changes the skeptic required are applied here rather than argued: the attribution of D1's
*"lands regardless"* sentence (§4.1 — it is a recording session's reading, not the owner's words),
and the count of `62` §16.4's requirements (§1.2 and §5 — three, plus one mechanism, not four).

---

## 2. The three principles that fix the order, and the four constraints from the record

### 2.1 Principles

**DECISION (sequencing) — three principles, applied in this order of precedence.**

1. **The owner's priorities put the demo-visible decisions first.** *"again the goal is to use this
   to demo to my boss"* (`70` §19.5). He asked for groups and tags by name (`70` §19.1: *"A real
   named set"*; *"We also needed a tagging system as well"*), named *"rack(s)"* among the views
   (`70` §19.4), and said the demo is *"arista and juniper SRX bare metal"* (`70` §20.3). D1's
   defect — a hand-added server must borrow `junos-srx` — is on the first screen
   (`OPEN-FOR-THE-OWNER.md` §D1: *"today your Proxmox box is filed as a Juniper firewall"*).
2. **One decision per bump.** The version comment prices one change per paragraph and has since
   0.2; a bump that carries two decisions has one paragraph pricing two things, and the next reader
   cannot tell which line belongs to which. This is why D7 and D5 are not folded (§6.1).
3. **A major-class change lands alone, last, after every minor.** Failure modes item 1's own
   sentence, and `62` §16.4: whatever rides in the same bump inherits the three requirements.

### 2.2 Constraints from the record, each fixing one pairwise order

| Constraint | Source | Order it fixes |
|---|---|---|
| D6's per-kind block must be computed once over the final kind set, as one contiguous key range | Failure modes item 3 (first half) | groups-and-tags and D4 **before** D6 |
| D3 replaces the whole `Device.role` entry; D4 amends one sentence of its doc — whichever lands second carries the other's text | Failure modes item 3 (second half) | D4 **before** D3, so the replacement carries the amended sentence rather than the amendment re-editing the replaced entry |
| D1's clear-a-platform control and D3's empty-set open item are one missing control (`parse_into_slot` refuses an empty value; `Graph::clear_field` has no caller outside tests; no opcode clears) — *"Build it once"* | Failure modes item 4 | D1 **before** D3, so D1's order builds it and D3's reuses it |
| D5's layer-based drift test and §8's name-based exclusions must be reconciled by whichever lands second | Failure modes item 2 | groups-and-tags **before** D5, so D5 carries the reconciliation and `Group`/`Tag` are a known quantity when it does (§6.2) |

Every other pair is free, and principle 1 or 2 decides it.

---

## 3. The landing order — one table

**DECISION (sequencing).** Versions and keys are assigned strictly in landing order from the real
tail of `schema/field-keys.yaml`, which is **311** (§9.1). The next key is 312. Counts *after
landing* are kinds · edges (declared + derived) · field keys · enum files; the enum-file column
assumes D4's `Fixture.form` declares **no** file — the `Fixture` block lies beyond the record's
2,500-character cut, so read that column off the run at position 3 and carry the correction
forward.

| # | Decision — RECOMMENDATIONS § | Version | Class, by `62` §16.2 | Field keys | After landing |
|---|---|---|---|---|---|
| 1 | **D1** — hosts, NAS boxes and hypervisors: blank platform (§15) | **0.5, unchanged** | none — no row for a `doc:` edit or a registry row; nothing removed, retyped, tightened, reordered or re-owned (§15.5) | none | 51 · 95 · 311 · 10 |
| 2 | **D2 / D10** — `Group` and `Tag` (§8) | **0.5 → 0.6** | minor | **312–314** | 53 · 99 · 314 · 10 |
| 3 | **D4** — `Fixture`, `Chassis.height_u`, `MountedIn` widened (§10) | **0.6 → 0.7** | minor | **315–318** | 54 · 101 · 318 · 10 |
| 4 | **D7** — `RoutingInstance` identity tuple (§13) | **0.7 → 0.8** | minor | none | 54 · 101 · 318 · 10 |
| 5 | **D5** — `presentation` layer; `LayoutPin` moves onto it (§11) | **0.8 → 0.9** | minor, by the table's own criterion — no row (§11.5) | none | 54 · 101 · 318 · 10 |
| 6 | **D6** — `lifecycle` field, enum `lifecycle_stage` (§12) | **0.9 → 0.10** | minor | **319–371** | 54 · 101 · 371 · 11 |
| 7 | **D3** — `Device.role` becomes `set{device_role}` (§9) | **0.10 → 0.11**, alone | **MAJOR-class**, taken pre-1.0 | none — **key 9 kept** | 54 · 101 · 371 · 12 |
| 8 | **E4** — `emit:` on dictionary entries; `emit_dict` hooks populated (§14) | **no bump** — stays at whatever is current (0.11 if last) | none — data, not grammar (§14.5) | none | unchanged |

Two things the table does not show and §4 does: the per-position secondary counts (`Placeable`
members, containment kinds and pairs, `emit_dict` hooks, layer distribution), and the owner's gate
on each.

---

## 4. Each position: why here, what it depends on, what the counts are after it lands

### 4.1 Position 1 — D1, schema 0.5 unchanged

**Bump class: none.** `62` §16.2 has no row for a `doc:` edit and no row for a platform-registry
addition; nothing is removed, retyped, tightened, reordered or re-owned (§15.5). Confirmed on the
tree: the only `schema/` edit is one explanatory note in `Device.platform`'s `doc:`, and
`Device.platform` keeps key 7, type `PlatformId`, card `1`, emit `R` (`schema/schema.yaml`, kind
`Device`; `field-keys.yaml` `Device.platform: 7`). It is **not** zero-touch: `schema.json` carries
`doc:` verbatim (`schemagen/src/lib.rs:134–160` is a passthrough of every top-level block), so
`fathom-schemagen` re-runs, both generated outputs are committed (`schema.codegen.stale` fails
otherwise), and the content hash moves while the version does not. The `proxmox-ve` row is decided
now and written later, and is also no bump when it lands (§15.5).

**Why here.** Principle 1. The demo is the goal (`70` §19.5) and the defect is on the first screen.
On the host-engine question: `70` §20.4 records, **as the recording session's reading adopted
until he corrects it — not his words; his words were *"Docker container only please"*** — that
D1's blank-platform change lands regardless of any host engine; `70` §20.6 repeats that reading
under his *"Fathom will have engines … Fathom itself will be hosted in a docker though."* The
position does not rest on that reading. It rests on the first-screen defect and on Failure modes
item 4: D1's clear-a-platform deliverable and D3's empty-set open item are the same missing control
— `parse_into_slot` (`crates/fathom-inventory/src/author.rs:72`; its own doc: *"An empty string is
not treated as 'no value'"*) refuses an empty value, `Graph::clear_field`
(`crates/fathom-graph/src/graph.rs:859`) has three callers and all are tests, and no opcode clears
— so D1's order builds it once and D3's order reuses it. Its own commit, not folded into 0.6, so
the 0.6 version comment stays one coherent change (principle 2) and a doc edit is never misread as
part of a bump.

**Depends on.** Nothing outstanding. The door-check removal was put to the owner as a decision made for him (`WHAT-I-RECOMMEND-2026-09-04.md` §1, *"A server or NAS can be added with the platform left blank"*) and he answered *"then please continue"* the same evening — approval by delegation, under the mandate in `70` §19.5 that technical decisions are the reviewer's. §15.7's two cautions — the silent duplicate on a later paste, and no way to clear a platform once set — are closed in the fix itself rather than deferred: the paste ASKS when a hostname matches a platform-less box, and the clear is either added or its absence stated in the commit. That commit is on this branch, dated 2026-09-04, driven in Chromium. <!-- The original text of this paragraph read the door-check removal as awaiting the owner; it was written before his 'continue' and is superseded, not wrong. -->

**After landing.** 51 kinds · 95 edges · 311 keys · 10 enum files — all unchanged. `Placeable` 50,
containment kinds 44, resolved pairs 98, `emit_dict` hooks 87 (1 live) — unchanged.

### 4.2 Position 2 — D2 / D10, groups and tags, 0.5 → 0.6

**Bump class: minor.** `62` §16.2: *New node kind | minor* ×2 (`Group`, `Tag`); *New edge kind |
minor* ×4 (`HasGroup`, `HasTag`, `GroupMember`, `AppliedTo`); *New optional field | minor* ×3
(fields on a new declarer, the 0.5 comment's reading). Both kinds hang off root by NEW containment
edges, so no existing kind's owner changes; `Placeable` is deliberately not widened (§8.3 item 2).

**Field keys: 312–314.**

**Why here.** Principle 1. The owner asked for both by name (`70` §19.1), D10 is answered by
implication (`70` §20.7: visibility follows role), and `70` §19.1 puts the kind on the critical path
for anything per-group — including the SCP/SFTP generation he asked for in the same message. It is
the first bump on 0.5, so **every number in §8 is correct as written**: kinds 53, edges 99 (91
declared + 8 derived), keys 314, containment kinds 46 (44 + `HasGroup` + `HasTag`), resolved pairs
**stay 98** — root is not a `NodeKind`, so a root-`from` edge names no `(NodeKind, NodeKind)` pair,
and neither kind is `Placeable`, so neither gains a `(kind, LayoutPin)` pair
(`crates/fathom-weld/tests/containment.rs` lines 30–80 state both halves of that rule) — the
orphans vector gains `Group` and `Tag` (seven names today → nine), `Placeable` stays 50, enum files
stay 10, and `emit_dict` hooks become 91 (1 live + 90 null) if the four new edges follow the file's
convention and declare `emit_dict: null` (`62` §6.3: *"or `null` for a never-emitted edge"*). The
`Placeable` drift test at this step is a **name list** — `{LayoutPin, Group, Tag}` — exactly as
§8.5 writes it; D5 reconciles it when it lands (§6.2).

**Depends on.** D2 answered (`70` §19.1) and D10 answered by implication (`70` §20.7) — both on
record. Open beneath it and put to the owner by §8.7 (a group cannot span drawings; visibility) do
not gate the schema. No dependency on D1; it simply lands after it.

### 4.3 Position 3 — D4, racks, 0.6 → 0.7

**Bump class: minor.** `62` §16.2: *New node kind | minor* (`Fixture`); *New edge kind | minor* ×2
(`HasFixture`, `RestsOn`); *Relaxed constraint / widened `from`/`to` set | minor* (`MountedIn`
`from: [Chassis]` → `[Chassis, Fixture]` — today `from: [Chassis]`, `schema/schema.yaml:2375`);
*New optional field | minor* ×4 (`Chassis.height_u` plus three on the new declarer). Zero removals
— `MountedIn.height_u` (key 306) stays declared and read (§10.1).

**Field keys: 315–318.** `Chassis.height_u = 315` — the number §10.5's placement form writes under
the old label — and `Fixture`'s three fields 316–318.

**Why here.** Principle 2 plus two of §2.2's constraints. It is the second kind-adder and must
precede D6 so D6's per-kind block is computed once over the final kind set with one contiguous key
range. It must precede D3 so D3's whole-entry replacement of `Device.role` carries D4's amended
doc sentence rather than the reverse. Rack views are in the owner's own list (`70` §19.4,
*"rack(s)"*) and the rung-2 elevation is live, so fixtures reach the demo.

**After landing.** Kinds 54; edges 101 (93 + 8); keys 318; `Placeable` 51; containment kinds
**47** (not §10's 45 — groups-and-tags already took 44 → 46); resolved pairs **100** (49 + 51 —
the same +2 §10 computed, `(Premises, Fixture)` through `HasFixture` and `(Fixture, LayoutPin)`
through `HasLayoutPin`, because groups-and-tags left it at 98); `emit_dict` hooks 93; enum files
10 **unless the `Fixture` block beyond the cut declares a file for `form` — read it off the run**
and carry the correction into every later enum-file count in this note.

**Depends on.** The owner's answer to §10.7 (a one-word fixture, not a power map). The rack-move
reopening (ADR-0036 §8 item 5: *"Refused by name today; somebody must decide its undo
semantics"*) is an opcode decision offered separately and does not gate the schema. D1's landed
state: D4's own `Device.role` doc sentence must be written against it (§8.3).

### 4.4 Position 4 — D7, the `RoutingInstance` identity tuple, 0.7 → 0.8

**Bump class: minor.** `62` §16.2: *New identity tuple appended | minor | old client: yes*.
Nothing else moves; identity tuples are never on the wire (`11` §10.3: *"never persisted as a
key"*). Today `RoutingInstance` declares `identity: []` (`schema/schema.yaml:558`).

**Field keys: none.**

**Why here.** The cheapest bump, and it fixes a defect the demo can hit: on any SRX paste carrying a
`routing-instances` block the relay's target is a pending reference that a reload loses (WO-10 §10
item 5, fired at execution 2026-08-29), and the demo is SRX and Arista (`70` §20.3). No interaction
with any other decision, so it sits between the kind-adders and the wire-neutral pair without
disturbing keys.

**After landing.** Unchanged at 54 · 101 · 318 · 10. `dict_gates.rs::entry_count_is_90`
(`crates/fathom-ingest/tests/dict_gates.rs:74`) → 91 — corpus, unaffected by landing order, and
read off the run rather than asserted (RECOMMENDATIONS *Disagreements* item 13). The dictionary
file ships under `corpus_version` (`62` §19.2), not this bump.

**Depends on.** The owner accepts route 1 (§13.7). WO-10 DONE (it is). No dependency on D4 or
groups-and-tags — if either is refused, D7 takes their number and nothing else about it changes
(§7).

### 4.5 Position 5 — D5, the `presentation` layer, 0.8 → 0.9

**Bump class: minor, by the table's own criterion.** No row in `62` §16.2 covers a new `layer`
value or a changed kind-level attribute; §11.5 prices it by the criterion the table is built on
(can an old client read the new export? — yes, byte for byte: `layer` is never serialised) and by
elimination of every major row. D5 proposes two rows to §16.2 (§11.1); the second — a kind's layer
changed INTO `config` — is major, and this change is the first row, not the second.

**Field keys: none.**

**Why here.** No wire change, no keys, no demo visibility: the defect it closes (a false
`Divergent` finding on every hand-placed pin of a re-pasted device) fires only when `11` §10.4
re-identification is built, and it is not. It lands second of the D5/groups-and-tags pair, so it
carries the Failure-mode-2 reconciliation (§6.2). Placed before D6 so the two drift tests —
`Placeable`, and lifecycle-on-every-kind — can share one exclusion rule; D6's set is the same
either way.

**After landing.** Counts unchanged at 54 · 101 · 318 · 10. The generated `Layer` enum gains
`Presentation`. Kind layers become **41 `config` + 1 `presentation`** (today 40 `config`, 5
`physical`, 6 `service` — read off `schema.yaml` 2026-09-04; groups-and-tags adds two `config`
kinds and D5 moves one out), with `physical`/`service` at 5-plus-`Fixture`'s / 6 depending on the
layer the cut `Fixture` block declares.

**Depends on.** The owner's yes/no (§11.7). Lands after groups-and-tags so `Group` and `Tag` are
already `layer: config` and the drift test's name list is a known quantity.

### 4.6 Position 6 — D6, the `lifecycle` field, 0.9 → 0.10

**Bump class: minor.** `62` §16.2: *New optional field | minor* ×53, plus a new enum file priced as
`62` §20.6 priced itself (`11` §11.3 rows 3–4). No kind, edge, retype, tuple or containment moves.

**Field keys: 319–371** — 53 fields (54 kinds − `LayoutPin`, D6's rule as written applied to the
kind set at landing; 319 + 52 = 371). If the D6 order excludes `Group` and `Tag`: 51 fields,
319–369. The general form, for whatever set the order settles on: 319 through 319 + (n − 1).

**Why here.** Last of the minors, for three reasons. It is the only decision whose count depends on
every kind-adder (Failure modes item 3), so it lands after groups-and-tags and D4 and its block is
computed once, contiguously. It spends the most keys and is the least answered — the owner's
Draft / Planning / Production (`70` §20.8, §20.10) is the design-level state that is explicitly NOT
D6 (§20.8(a): *"This is a design-level state and it is NOT D6"*), and §12.7's four questions stand
— so it sits where a refusal renumbers only D3. And the demo does not need it by name.

**After landing.** Kinds 54; edges 101; keys 371; enum files 11 (10 + `lifecycle_stage.yaml`, if
D4 added none). **Flagged for the D6 order, not decided here:** its rule as written puts
`lifecycle` on `Group`, `Tag` and `Fixture`; §12 priced alone and never considered whether a group
can be `planned`. That is a stop-and-escalate in D6's order, and §12.4 item 7's drift test is what
holds the per-kind declarations identical whichever set is chosen.

**Depends on.** D4 landed (or the count recomputed against the kind set actually present). The
owner's answers to §12.7: per-box word versus per-screen switch; refuse-or-mark on a capture-shown
element; the tag alternative. **A two-digit minor is safe today**: no code parses the version
numerically — §9.4 lists every consumer and all are exact-string.

### 4.7 Position 7 — D3, `Device.role` as a set, 0.10 → 0.11, alone

**Bump class: MAJOR-class.** `62` §16.2: *Field type changed | major | old client: no* — key 9
changes from a token to an array; an old build gets `CanonError::Shape`, not the unknown arm. NOT
the *widened cardinality upper bound | minor* row, because the `T` inside `Field<Presence<T>>`
changes (§9.5). The version string stays minor-shaped and the version comment says **major-class,
taken pre-1.0** in words — §9.5's form. §5 carries the whole handling.

**Field keys: none — key 9 kept.** The registry keys on the name and the name did not move. The
alternative §9.5 rejects — retire 9 and take the next key — would now take **372**, not 312.

**Why here.** Principle 3: alone, in its own bump, so nothing minor is dragged into `62` §16.4's
requirements. Last because it is the only decision with no recorded owner answer at all (§9's
header; `OPEN-FOR-THE-OWNER.md` §D3), so landing it last means a refusal renumbers nothing;
because D1 must precede it (the clear control) and D4 must precede it (the role doc); and because
with every minor already in, the major-class comment names one outgoing version (0.10) and one
migration note.

**After landing.** Kinds 54; edges 101; keys 371; enum files 12 (`device_role.yaml` after
`lifecycle_stage.yaml`).

**Depends on.** The owner's approval slot in the enum doc filled and dated (§9.7), and his
willingness to take a major-class change pre-1.0 rather than the minor-by-the-letter `roles`
fallback §9 recommends against. D1's clear control exists (Failure modes item 4). §9.5's clause (3)
— *"server rows — none exist"* — **re-verified against the tree at landing, not copied**: WO-12
(OPEN) creates `design_blob`, one opaque blob per design that the server never parses (WO-12 §4.2).

### 4.8 Position 8 — E4, `emit:` on dictionary entries, no bump

**Bump class: none.** Not a row in `62` §16.2: the only `schema/` edit is populating existing
`emit_dict:` hooks on five declared edges (data, not grammar); the `derived_edges` edit is dropped
(§14.5). `schema.json`'s content hash moves and is regenerated in the same commit; the version does
not. The dictionary side is a corpus bump (`62` §19.2).

**Field keys: none.**

**Why here.** Version-neutral: it can land at any position without disturbing a single number
above, so it is placed where it costs nothing — last. It is not demo-needed, it waits on a
planning-authored amendment to WO-04 or a successor order (§14.5; `78` §7), and it interacts with
none of the seven schema decisions (D3's `emit: "—"` on `role` has no hook). Its hook arithmetic
does move with the order: the table it edits is **93** hooks after groups-and-tags (+4) and D4
(+2), not 87.

**Depends on.** The owner's §14.7 answer; a planning session writing the order; WO-04 / WO-09
state. No schema-decision dependency.

---

## 5. The major-class bump: D3 at position 7, alone

D3 lands at position 7 as 0.10 → 0.11, after every minor (0.6 groups-and-tags, 0.7 D4, 0.8 D7,
0.9 D5, 0.10 D6) and after the two no-bump changes it depends on for content (D1's clear control;
D4's role-doc sentence, already in the file when D3 replaces the entry).

**The version string stays minor-shaped and the comment says major-class in words.** That is the
form §9.5 recommends, because the file has no way to say major short of declaring 1.0. `11` §11.2
fixes the form as `major.minor` with no patch; `0.11` is major 0, minor 11. **Declaring 1.0 instead
is a release decision** — a `schema/released/` snapshot and the bump checker going live — that this
note does not take and only the owner or a planning session can (*Open decisions*).

**`62` §16.4 names one mechanism and three requirements. Where each stands in this order:**

- **The mechanism — the bump checker — cannot fire.** `schema/released/` holds only `.gitkeep`
  (verified 2026-09-04), so `schema.version.bump-too-small` has no snapshot to diff against and
  stays *not yet checkable* on the `fathom-schema-check` run (it is in the run's own list, §9.2).
- **(a) A written migration note.** §9.3 and §9.5 write it — a single stored token `T` becomes the
  set `{T}`; a journal replay passes the bare word to the new author arm, which reads it as a
  one-word set. The D3 order must renumber it to name **0.10 as the outgoing version**, not 0.5.
- **(b) A `Migration` impl registered in the chain.** None, because the chain is empty by design
  (ADR-0036 §5.2: *"the manifest already records that the empty chain is deliberate until the
  first release"*; ADR-0037 §8 item 5 takes the same position). `schema/migrations/manifest.toml`
  regenerates to `schema_version = "0.11"`, `migrations = []` — it is generated by
  `fathom-schemagen` (`schemagen/src/lib.rs:250`), never hand-edited.
- **(c) A golden fixture for the outgoing version.** None is produced for 0.10, because there is no
  released 0.10 to fix it against, and the version comment says so exactly as §9.3 says it for 0.5.

**Nothing minor rides in.** D1 (position 1) is not a bump; D4's role-doc amendment is already in
the file when D3 replaces the whole entry, so D3 carries D4's text rather than the bump carrying
D4.

**One caveat the D3 order must carry rather than inherit.** §9.5's *"server rows — none exist
(WO-11 G8; WO-12 is OPEN)"* is true today and may not be at position 7: WO-12 §4.2 creates
`design_blob`, one opaque blob per design the server never parses. That does not create a
server-side migration — the server cannot read the blob; a journal replays the bare word as a
one-word set; a `fathom-plain` snapshot is already refused on any version mismatch — but the
sentence must be re-verified against the tree at landing, not copied.

**Why not land D3 early to beat that window.** It is the one decision with no owner answer, and
landing an unapproved major-class change at position 3 to preserve a sentence in its own record
would put five approved-or-nearly-approved minors behind a renumbering every time it slipped.

**The future checker must compare numerically.** When `62` §16.4's checker is implemented it must
read `0.10 > 0.9`; `11` §11.4's *"a higher `schema_version.minor`"* already implies a numeric
minor. No code compares versions today except `fathom-workspace`'s exact string match (§9.4), which
is order-blind and therefore safe.

---

## 6. The three cross-decision conflicts, resolved

### 6.1 Item 1 — six decisions each named 0.6; three each started at 312

**Resolved by assigning versions and keys strictly in landing order from the real tail, 311:**
groups-and-tags 0.6, keys 312–314; D4 0.7, keys 315–318; D7 0.8, no keys; D5 0.9, no keys; D6
0.10, keys 319–371 (53 fields over 54 kinds − `LayoutPin`); D3 0.11 alone, major-class, key 9
kept; D1 and E4 no bump.

The record's *"312"* was the correct NEXT key — the tail is 311, contiguous, no duplicates (§9.1)
— so §8's numbers are right **because it lands first**, and every other decision's numbers are
wrong because it does not. §8 of this note lists the substitutions.

**Nothing mechanical enforces this today.** `schema.version.bump-too-small` is not checkable;
`schema.order.inserted` is declared (`62` §18) but not implemented (it is in the run's
*not yet checkable* list, §9.2; D6 fix 6 says the same). The version comment and the test pins
listed per decision in §8 are the enforcement.

**RECOMMENDATION — principle 2 read as one decision per bump.** Folding the two wire-neutral
changes D7 and D5 into a single 0.8 would save one number and cost one coherent pricing paragraph.
Not taken. If a planning session takes it, D6 becomes 0.9 and D3 0.10, with every key unchanged.

### 6.2 Item 2 — D5 and groups-and-tags disagree about the `Placeable` drift test

**Resolved by sequencing.** Groups-and-tags lands first (0.6) with the name list
`{LayoutPin, Group, Tag}` exactly as §8.5 writes it. D5 lands second (0.9) and carries the
reconciliation: the drift test's exclusion becomes *`layer == presentation` OR `name ∈ {Group,
Tag}`* — the name list kept beside the layer rule. That is the one of Failure modes item 2's two
options that decides no content; the other — a non-config layer for `Group` and `Tag` — is the
classification D5 fix 6 says a grammar row must not pre-decide and `70` §19.1 reserves for a
planning session on the group/tag shape.

**Deliberately NOT decided here:** whether `Group` and `Tag` later move out of `config`. By D5's
own proposed first row that would be minor and byte-identical, and the name list would empty on
that day; whether it should happen is content.

### 6.3 Item 3 — D4 and D6 change each other's counts; D4 amends `Device.role`'s doc while D3 replaces the entry

**Resolved by ordering D4 (0.7) before D6 (0.10) and before D3 (0.11).** D6's *"every kind but
`LayoutPin`"* is then computed once over 54 kinds — 53 fields, keys 319–371, one contiguous block
— and D4's `Fixture` block does not carry `lifecycle` at its own landing; D6 appends it with the
rest. D3's replacement of the `role` entry carries D4's amended sentence.

**And a third stale text this ordering exposes.** D4's own amendment says a managed strip or UPS
*"stays a `Device` with role `other` until D1 is answered (§15)"*. D1 lands at position 1, so D4's
executor writes that sentence against D1's landed state — role `other`, platform not known as a
gap — and D3's executor carries that corrected form. Today's sentence in the tree is the
pre-amendment one: *"`pdu` and `ups` … stay `other` until someone wants power in the elevation,
and that is a rack question, not a role question"* (`schema/schema.yaml`, `Device.role` doc), and
it becomes false the moment `Fixture.form` declares `pdu` and `ups` (§10.1).

**Item 4 is not a sequencing conflict but drives one ordering above:** D1 before D3, so the clear
control is built once.

---

## 7. The shift rule when a decision is refused

**Rule.** Everything behind a refused decision takes the next lower version; its keys close the
gap; every count is recomputed against the kind set actually present. E4 stays no-bump at whatever
is current. The order among the survivors does not change.

| Refused | What moves | What does not |
|---|---|---|
| **D1** | Nothing numeric — it was no bump. D3's order must build the clear control itself (Failure modes item 4's *"once"* becomes D3's), and D4's doc sentence keeps *"until D1 is answered"* | every version and key |
| **Groups-and-tags** | D4 0.6, keys **312–315** — §10's numbers become correct as written; D7 0.7; D5 0.8; D6 0.9, 52 fields at **316–367**; D3 0.10. Containment kinds 44 → 45 (§10's own figure), pairs 98 → 100, `Placeable` 50 → 51, hooks 87 → 89 → E4 edits 89. D5's drift test needs no name list beyond `LayoutPin` — item 2 never arises | D7, D5, D3 content |
| **D4** | D7 0.7; D5 0.8; D6 0.9 with 52 fields at **315–366**; D3 0.10. Kinds 53, `Placeable` 50, containment 46, pairs 98, hooks 91. D3's replaced `role` entry carries the sentence as D1 left it, with no D4 amendment | groups-and-tags 0.6, 312–314 |
| **D7** | D5 0.8; D6 0.9; D3 0.10 | every key |
| **D5** | D6 0.9; D3 0.10. The drift test keeps the name list `{LayoutPin, Group, Tag}` — item 2 never arises | every key |
| **D6** | D3 0.10; keys stay at **318**; enum files 11 after D3 (`device_role.yaml` only) | everything before it |
| **D3** | Nothing renumbers; E4 lands on 0.10 | everything |

A refusal that arrives **after** a later decision has landed does not un-number anything: keys are
never reused (`62` §2.3, *"assigned once and never reused"*; §8.5's own reversal note) and a
version once written stays written. The rule above is for refusals that arrive before the position
is reached.

---

## 8. What each later order must change in its own section of the record

Every YAML block in RECOMMENDATIONS §8–§13 says `0.6`; only §8's is right. An executor who copies a
block verbatim ships the wrong version. Per decision:

- **D1 (§15).** Nothing numeric changes — it lands first with no bump, so *"`schema.version` stays
  0.5"* is correct as written. Its order must build the clear-a-platform control so that D3 can
  reuse it (Failure modes item 4), and must confirm the door removal against the `equip.rs:497`
  two-role test (`a_server_and_an_access_point_can_be_added_and_are_named_as_such`) and the
  five-row LAB driver (`2026-08-16-server-role-drive.mjs`) as §15.1 names them.
- **Groups and tags (§8).** Every number correct as written because it is the first bump on 0.5:
  version 0.6, keys 312–314; `shipped_tree.rs` kinds 53 / edges 99 / keys 314 / `"0.6"`;
  `canon_laws.rs` `SCHEMA_VERSION` `"0.6"` and `FIELD_KEYS.len()` 314; `edge_tables.rs` 314;
  `plain_face.rs` `PINNED` `schema 0.6`; `containment.rs` 46 containment kinds with the orphans
  vector gaining `Group` and `Tag` and `resolved` staying 98; `manifest.toml` `"0.6"`. **One text
  change:** `shipped_tree.rs`'s edge-count message *"(87 + 8 derived)"* (line 68) becomes
  *"(91 + 8 derived)"*.
- **D4 (§10).** Version 0.6 → 0.7 throughout (version comment *"0.7 is D4"*, manifest `"0.7"`,
  the four version pins). Keys 312–315 → **315–318**; §10.5's *"stops writing key 306 and writes
  312 under the same visible label"* → writes **315**. Pins it says move FROM 51/95/311/`"0.5"` now
  move from 53/99/314/`"0.6"` TO 54/101/318/`"0.7"` (`shipped_tree.rs`; `canon_laws.rs`
  `FIELD_KEYS.len()` 318; `edge_tables.rs` 318). `containment.rs`: resolved 98 → 100 stands
  (groups-and-tags left it at 98), but containment kinds go **46 → 47**, not 44 → 45. `Placeable`
  50 → 51. Its `Device.role` doc amendment must be written against D1's landed state (the *"until
  D1 is answered"* clause is stale by position 3). Enum-file count after landing is 10 unless the
  cut `Fixture` block declares a file for `form` — read off the run, not assumed.
- **D7 (§13).** Version 0.6 → 0.8 throughout (version comment *"0.8 is D7"*, manifest `"0.8"`, the
  four pins). Its own `fathom-schema-check` line *"51 kinds · 95 edges · 61 scalars · 10 enums"*
  reads 54 · 101 · 61 · 10 at landing (enum count subject to D4's `Fixture.form`). Keys stay 318.
  `entry_count_is_90` → 91 is unchanged by the order.
- **D5 (§11).** Version 0.6 → 0.9 throughout. *"`shipped_tree.rs` counts stay 51 kinds / 95
  edges"* → stay 54 / 101; keys stay 318. The drift test switches to the layer rule AND keeps the
  name list `{Group, Tag}` (§6.2). Its forward-compatibility sentence — *"A 0.5 export opens in a
  0.6 build and a 0.6 export opens in a 0.5 build identically"* — must be re-scoped to **0.8 ↔ 0.9**,
  and scoped to the artifact it is true of: **the page's exported journal**, which carries no
  schema version at all (`exportJournal`, `fathom-dev.src.html:10362`, writes `magic`,
  `version: EXPORT_VERSION` — the journal's own format number, 3 — `warning` and `ops`). The
  byte-identity D5 claims holds between the build before D5 and the build after it, on that
  journal; it does not extend back to 0.5, because a 0.5 build already refuses the `Group`, `Tag`
  and `Fixture` records that 0.6 and 0.7 added (§8.5's `importJournal` finding). A `fathom-plain`
  snapshot is a different artifact and is refused on **any** version mismatch by exact string match
  (`crates/fathom-workspace/src/lib.rs:181`), adjacent or not — the same scope §11.5 already has
  and §9.5's (1)/(2) split already draws. Layer distribution after landing: 41 `config` + 1
  `presentation`, with `physical`/`service` per `Fixture`'s declared layer.
- **D6 (§12).** Version 0.6 → 0.10 throughout (version comment *"0.10 is D6"*, manifest `"0.10"`,
  the four pins). *"Fifty fields, fifty keys 312–361"* → **fifty-three fields, keys 319–371** (54
  kinds − `LayoutPin`, its rule as written); §12.4 item 3's *"the fifty keys 312–361 are spent"* →
  fifty-three, 319–371. Test pins: `shipped_tree.rs` lines 70 / 74 / 95 to 11 enum files / 371
  keys / `"0.10"` (kinds 54, edges 101 unchanged by D6); `canon_laws.rs` lines 82 and 575 to
  `"0.10"` and 371; `edge_tables.rs` line 95 to 371. *"Eleven enum files"* holds only if D4 added
  none. The per-kind block must be appended to `Group`, `Tag` and `Fixture` as well as the fifty;
  whether `Group` and `Tag` should carry it is the D6 order's stop-and-escalate, and if excluded
  the numbers are 51 fields, 319–369, 369 in every pin. Its forward-compatibility sentence stays
  `VERIFY` (§12.5) — nothing here settles it, and the version comment must not say *tolerated*
  until the drive §12.5 asks for has been run.
- **D3 (§9).** *"taken as schema 0.6"* → 0.11; the migration note's outgoing version 0.5 → 0.10;
  *"every 0.5 plain snapshot is refused by a 0.6 build"* → every 0.10 snapshot by a 0.11 build; §9.4
  item 8's *"Schema 0.6 is the first version an older build could not read even in a future
  preserve mode"* → 0.11; §9.5's rejected alternative *"retiring 9 and taking 312"* → taking 372.
  Enum files 11 → 12 (`device_role.yaml` lands after `lifecycle_stage.yaml`). The `Device.role`
  doc it replaces must carry D4's amended sentence in its D1-corrected form. Its *"one open item"*
  (an empty set cannot be written) must be checked against D1's landed clear control rather than
  left open. §9.5 clause (3) *"server rows — none exist"* re-verified against the tree at landing
  (WO-12's `design_blob`). The `server-role-drive.mjs` rewrite (line 72, `selectOption('#ef9', …)`)
  is unchanged by the order.
- **E4 (§14).** *"`schema/schema.yaml` stays 0.5"* → stays at the current version, 0.11 if it lands
  last. The hook table it edits is 93 rows after groups-and-tags (+4) and D4 (+2), not 87, so *"1
  live + 86 null today"* reads 1 live + 92 null before its five edges gain hooks; whether the
  existing live hook (`ExternalInterface`'s, `schema.yaml`'s one non-null `emit_dict`) is among the
  five is read off the run. Nothing else in §14 carries a schema-version number.

---

## 9. Verified against the tree, 2026-09-04

Everything a number in this note rests on, opened or run on the date, in one place.

### 9.1 The key registry's tail is 311

`schema/field-keys.yaml` holds 311 entries, keys 1–311, contiguous, zero duplicates, monotonic in
file order — counted with a numeric scan over every `name: N` line, not read off the file's last
line (which is `DhcpRelay.minimum_wait_time: 311`, and happens to agree). **The scan must admit
digits in field names:** `Application.l4: 132` (line 168) is a real key, and an alpha-only regex
counts 310 and reports a false gap at 131 → 133. The next key is 312.

### 9.2 The schema check, run

`cargo run -p fathom-schema --bin fathom-schema-check`: **51 kinds · 95 edges · 61 scalars · 10
enums · 14 files parsed; 0 failures, 0 warnings.** Its *not yet checkable* list (11 gates) includes
`schema.version.bump-too-small`, `schema.migration.chain-broken` and `schema.order.inserted`. The
field-key monotonicity gate is `proposed:schema.fieldkey.nonmonotonic`
(`crates/fathom-schema/src/gates.rs:448`).

### 9.3 Declarations, counted off `schema/schema.yaml`

- `kinds:` 51; `edges:` 87 declared; `derived_edges:` 8; 87 + 8 = 95, matching
  `shipped_tree.rs:68`'s message *"(87 + 8 derived)"*.
- Kind layers: 40 `config`, 5 `physical`, 6 `service`. `LayoutPin` is `layer: config` (line 1222).
- `Placeable`: 50 members (every kind but `LayoutPin`; `shipped_tree.rs`
  `every_kind_but_the_pin_itself_is_placeable` pins the equality).
- `MountedIn`: `class: reference`, `from: [Chassis]`, `to: [Rack]` (lines 2373–2376).
- `RoutingInstance`: `identity: []` with the `VERIFY` comment (line 558).
- `emit_dict:` hooks: 87, exactly one non-null (`junos-srx/security.ike.gateway.external-interface`).
  `62` §6.3: a reference, *"or `null` for a never-emitted edge"*.
- Root-`from` edges: 5 (`from: [root]`), matching `containment.rs`'s prose.
- `Device.platform`: key 7, `PlatformId`, card `1`, emit `R`. `Device.role`: inline
  `enum { firewall, router, switch, load_balancer, server, access_point, other }`, card `0..1`, key 9.
- The version block's 0.2–0.5 paragraphs (lines 6–60, before `scalars:` at 61): one change priced
  per paragraph.

### 9.4 Every consumer of the schema version string

- `crates/fathom-ir/src/generated/ir_types.rs:15` — `pub const SCHEMA_VERSION: &str = "0.5"`,
  emitted by `crates/fathom-schemagen/src/rust_gen.rs:79`.
- `crates/fathom-schemagen/src/lib.rs:213` (into `schema.json`, passthrough) and `:250` (into
  `manifest.toml`, `schema_version = "…"`).
- `crates/fathom-workspace/src/lib.rs:140` writes it into the plain header; `:181` compares it by
  exact string equality (`if declared != SCHEMA_VERSION`) and refuses on mismatch.
- Tests: `canon_laws.rs:82`, `plain_face.rs` (`PINNED` line 47 `schema 0.5`; the
  `pinned_header_tracks_the_schema_version` and bumped-header tests are string operations),
  `shipped_tree.rs:95`.
- **None** in `crates/fathom-artifact/html/fathom-dev.src.html`, `crates/fathom-wasm/src`,
  `crates/fathom-server/src`, `scripts/` or `.github/workflows/ci.yml` (grepped for
  `SCHEMA_VERSION`, `schema_version`, `schemaVersion`, `schema.version`, `"0.5"`).
- **No numeric parse anywhere** (grepped `fathom-schema`, `fathom-schemagen`, `fathom-workspace`,
  `fathom-wasm`, `fathom-ir/src` for `parse::<`, `split('.')`, `semver` against a version). So
  `"0.10"` is safe today; §5's numeric-comparison requirement is for the future checker.

### 9.5 Test pins, by line

`crates/fathom-schema/tests/shipped_tree.rs` 67 (kinds 51), 68 (edges 95), 70 (enum files 10), 74
(keys 311), 95 (`"0.5"`); `crates/fathom-ir/tests/canon_laws.rs` 82 (`"0.5"`), 575 (311);
`crates/fathom-ir/tests/edge_tables.rs` 93–96 (311); `crates/fathom-weld/tests/containment.rs` 80
(resolved 98), 96 (containment kinds 44), orphans vector of seven; `schema/migrations/manifest.toml`
`schema_version = "0.5"`, `migrations = []`, header *"GENERATED by fathom-schemagen"*;
`schema/released/` `.gitkeep` only.

`containment.rs` states the two-per-`Placeable`-kind rule in its own comment (lines 73–79: a new
`Placeable` kind costs TWO pairs, one as child and one as owner of its pin) and the root rule
(lines 32–35: root is not a node kind, so a root-`from` edge names no pair). Its prose says *"The
43 containment kinds"* (line 82) above an assert of 44 (line 96) — a stale comment, noted under
*Failure modes*.

### 9.6 Code facts the ordering leans on

- `parse_into_slot`: `crates/fathom-inventory/src/author.rs:72`; its doc comment (line 68):
  *"Refuses rather than coerces. An empty string is not treated as 'no value'"*.
- `Graph::clear_field`: `crates/fathom-graph/src/graph.rs:859`; callers outside its own file:
  `plain_face.rs:302`, `snapshot.rs:519`, `fields.rs:142` — all tests.
- `fathom_layout::layers::projection_of` (`layers.rs:228`): an exhaustive `match` with no wildcard
  arm — every new kind is a compile error until given an arm, which is the record's E0004 finding.
- `fathom_layout::agg::live_nodes` (`agg.rs:425`) — the exclusion list §8.3 extends.
- `dict_gates.rs::entry_count_is_90` at line 74.
- `crates/fathom-wasm/tests/equip.rs:497` — the two-role test, by its real name.
- `docs/80-review/evidence/2026-08-16-server-role-drive.mjs:72` —
  `if (role) await page.selectOption('#ef9', role);`.
- `exportJournal` at `fathom-dev.src.html:10362`; `EXPORT_MAGIC = 'fathom-journal'` (10311),
  `EXPORT_VERSION = 3` (10330).

### 9.7 Documents

- `OPEN-FOR-THE-OWNER.md` §D1 (line 240) and §D3 (line 294) — D3 has no answer under it.
- `70` §19.1, §19.4, §19.5, §20.3, §20.4, §20.6, §20.7, §20.8, §20.10 — the owner's words quoted
  in this note are from there, and the *"lands regardless"* sentence is the session's reading in
  §20.4 and §20.6, not his.
- WO-10 §10 item 5 (*"Fired 2026-08-29, at execution"*); WO-12 §4.2 (`design_blob`, *"the server
  never parses"*); ADR-0036 §5.2 and §8 item 5; ADR-0037 §8 item 5; `11` §10.3, §11.2, §11.3,
  §11.4, §11.5; `62` §2.3, §4.2, §6.3, §16.1–§16.4, §18, §19.2, §20.6; `78` §7;
  `.context/conventions.md` (invariants; *Document conventions*).

---

## Failure modes

1. **This note's numbers are right only if the order is followed and every decision lands.** §7 is
   the repair for a refusal; there is no repair for landing out of order except recomputing from
   the real tail. A session that assigns a key from this table without re-reading the tail of
   `field-keys.yaml` will collide the first time anything has landed out of sequence.
2. **Nothing mechanical enforces the sequence.** `schema.version.bump-too-small` cannot fire and
   `schema.order.inserted` is not implemented (§9.2). The version comment and the test pins are
   the only enforcement, and a pin is only enforcement while it is retyped from the file rather
   than from the failing run — `78` §5.5's laundering rule applies to a count as much as to a
   golden.
3. **`0.10` sorts before `0.9` as a string.** Any script, table or gallery that orders versions
   lexically will misorder the last two bumps. `fathom-workspace` is safe because it compares for
   equality only. The future `62` §16.4 checker must compare numerically (§5).
4. **The version string never says major.** A reader of `schema.version` alone sees `0.11` and
   reads minor. The word is in the comment and in D3's record, nowhere machine-readable; declaring
   1.0 is the only way to put it in the string, and that is a release decision (*Open decisions*).
5. **Two counts depend on text beyond the record's cut.** The enum-file column (whether
   `Fixture.form` is a file) and D6's field count (whether `Group`, `Tag` and `Fixture` carry
   `lifecycle`) each have two or three legal values; the table shows one and §4.3 / §4.6 say which
   run reads the real one. A pin typed from this note instead of from the run is a pin typed from a
   guess.
6. **Every YAML block in RECOMMENDATIONS §8–§13 says `0.6`.** Only §8's is right. An executor
   copying a block verbatim ships the wrong version, and no gate catches it (item 2). §8 of this
   note is the substitution list; the block in the record is not corrected in place.
7. **D3's server-rows sentence goes stale at position 7.** §9.5's *"none exist"* is true on
   2026-09-04 and false once WO-12 executes. The consequence is nil for the migration (§5) and
   non-nil for the sentence; §4.7 requires re-verification, not a copy.
8. **The forward-compatibility claims in the tree and the record are not all true, and this note
   repeats none of them.** The 0.5 version comment says an old build *"keeps it in `unknown`"*;
   groups-and-tags fix 1 established that `importJournal` stops at a record of a kind it does not
   know. D6's tolerated-direction sentence is marked `VERIFY` and stays so. If the drive §12.5 asks
   for comes back *refused*, no version or key in this note moves — only D6's comment does.
9. **The re-scoped D5 sentence is true of one artifact.** The journal carries no schema version;
   the plain snapshot is refused on any mismatch. A sentence that says *"a 0.8 export opens in a 0.9
   build"* without naming the artifact is true of the journal and false of the snapshot (§8, D5).
10. **A stale comment in the tree.** `containment.rs` says *"The 43 containment kinds"* above an
    assert of 44 (WO-10 raised it and left the prose). The first order to touch that file
    (groups-and-tags, 44 → 46) should correct it in passing, as `78` §8 allows.
11. **The D1 attribution is the kind of slip this note is most likely to reintroduce.** *"The owner
    said"* was written where the record said *"the reading adopted until he corrects it"*. The rule
    RECOMMENDATIONS §1 item 6 applies across the record applies here: no *"the owner asked /
    answered"* where `70` does not carry it in his words.

## Open decisions

**The owner's** — each decision's own gate, listed in RECOMMENDATIONS *Open decisions* (*Data
model*) and not restated here; §4's *depends on* rows name them per position. Added by this note:

- Whether D3 declares **1.0** rather than 0.11 — a `schema/released/` snapshot and the bump checker
  going live, which is a release decision (§5). Not taken here.

**Planning's:**

- Whether to fold D7 and D5 into one bump (§6.1, recommended against).
- Whether `62` §16.2 gains the two rows D5 proposes (§11.1) and rows for the three no-row cases
  this note priced by argument (a `doc:`-only edit, a platform-registry row, an `emit_dict` hook
  population — *"no bump, hash moves"*, §14.5's own phrase). `62`'s owner's; until then the version
  comment is the only record.
- Whether `00-INDEX.md` carries a pointer to this note. This note edits nothing but itself and one
  paragraph of RECOMMENDATIONS *Failure modes* item 1; the index is planning-maintained.
- The record each landing needs — an ADR (ADR-0035/0036/0037's precedent) or a work order
  (WO-10's) — is authored per decision and is not this note.
- Whether `Group` and `Tag` ever leave `layer: config` (§6.2 — content, deliberately not decided).
- D6's stop-and-escalate on `Group`, `Tag` and `Fixture` (§4.6).

## Sources consulted

Read date 2026-09-04 throughout. Every row was opened or run by this note, not carried from the
record.

| What | Where |
|---|---|
| §16 in full (§16.1–§16.4); §2.3; §4.2; §6.3; §18 gate table; §19.2; §20.6 | `docs/60-content/62-schema-spec.md` |
| §0–§1, §8–§15 in full, *Failure modes*, *Open decisions* (*Data model*), *Sources consulted* (the eight schema decisions), *Disagreements* | `docs/70-ops/RECOMMENDATIONS-2026-09-04.md` |
| §19.1–§19.5, §20.1–§20.10 verbatim | `docs/70-ops/70-owner-answers-and-standing-priorities.md` |
| §D1 (line 240), §D2, §D10, §D3 (line 294) | `docs/70-ops/OPEN-FOR-THE-OWNER.md` |
| The version block (lines 1–56); `Device.platform` and `Device.role`; `LayoutPin` (1221–1222); `RoutingInstance` (539–558); `MountedIn` (2373–2385); every `emit_dict:`; every `layer:`; every `- edge:` | `schema/schema.yaml` |
| Tail, and a numeric scan of all 311 entries | `schema/field-keys.yaml` |
| `schema_version = "0.5"`, `migrations = []`, generated header | `schema/migrations/manifest.toml` |
| `.gitkeep` only | `schema/released/` |
| 10 files | `schema/enums/` |
| 51 · 95 · 61 · 10; 0 / 0; the not-yet-checkable list | `cargo run -p fathom-schema --bin fathom-schema-check` |
| Lines 60–150: the counts and the `Placeable` drift test | `crates/fathom-schema/tests/shipped_tree.rs` |
| Lines 78–86, 570–580 | `crates/fathom-ir/tests/canon_laws.rs` |
| Lines 90–100 | `crates/fathom-ir/tests/edge_tables.rs` |
| Lines 30–115 | `crates/fathom-weld/tests/containment.rs` |
| `PINNED` (44–47), `pinned_header_tracks_the_schema_version` (365–369), the bumped-header test (390–396) | `crates/fathom-workspace/tests/plain_face.rs` |
| Lines 31, 54, 140, 170–195 | `crates/fathom-workspace/src/lib.rs` |
| Line 15 (`SCHEMA_VERSION`), 21 (`Layer`), 417 (`identity_tiers`), 473 (`layer()`) | `crates/fathom-ir/src/generated/ir_types.rs` |
| `rust_gen.rs:79`; `lib.rs:137, 213, 250` | `crates/fathom-schemagen/src/` |
| `gates.rs:12, 448` | `crates/fathom-schema/src/` |
| `author.rs:5–15, 72` | `crates/fathom-inventory/src/` |
| `graph.rs:855–870` and every `clear_field` caller | `crates/fathom-graph/`, `crates/fathom-workspace/tests/` |
| `layers.rs:228` (`projection_of`, no wildcard arm); `agg.rs:425` (`live_nodes`) | `crates/fathom-layout/src/` |
| `shell.rs:645–665` (`field_set`) | `crates/fathom-wasm/src/` |
| `equip.rs:495–500` | `crates/fathom-wasm/tests/` |
| `dict_gates.rs:74` | `crates/fathom-ingest/tests/` |
| Lines 10055–10085 (the paste-reply tail), 10311, 10330, 10362–10400 (`exportJournal`); grepped for every schema-version spelling | `crates/fathom-artifact/html/fathom-dev.src.html` |
| `src/`, `scripts/`, `.github/workflows/ci.yml` — grepped for every schema-version spelling, none | `crates/fathom-server/`, repo root |
| Line 72 | `docs/80-review/evidence/2026-08-16-server-role-drive.mjs` |
| §10 item 5 | `docs/70-ops/79-work-orders/WO-10-dhcp-relay-and-bootp.md` |
| §4.2 (`design_blob`), the table row *"the server never parses"* | `docs/70-ops/79-work-orders/WO-12-the-key-boundary-and-the-first-stored-row.md` |
| §5.2; §8 item 5 | `docs/90-decisions/adr-0036-physical-placement-is-graph-data.md` |
| §8 item 5 | `docs/90-decisions/adr-0037-a-server-is-a-device-with-a-role.md` |
| §10.3; §11.2–§11.5 | `docs/10-core/11-ir-schema.md` |
| §7 | `docs/70-ops/78-execution-protocol.md` |
| Terminology, Precedence, invariants 1–10, *Document conventions* | `.context/conventions.md` |
| Head, for the house shape of a `00-` note | `docs/70-ops/79-work-orders/00-INDEX.md`, `00-ROUTE-TO-WORKABLE.md` |

## Disagreements

1. **With the skeptic's citation for `exportJournal`.** The skeptic's optional change places it at
   `fathom-dev.src.html:10065`. Line 10065 is inside the tail of the paste-reply handler
   (`S.pasteWasTable = looksLikeRulesTable(text)` …); `exportJournal` is at **line 10362**. The
   substance is right and is applied (§8, D5): the function writes `magic`, `version:
   EXPORT_VERSION` (3 — the journal's format number), `warning` and `ops`, and no schema version.
   The line number is corrected here so the next reader does not open the wrong function.
2. **With the skeptic's span for `62` §16.2.** *"read in full, lines 974–1030"* is the span of §16
   as a whole (§16.1–§16.4); §16.2 is lines 988–1012. Nothing turns on it — §16 was read in full
   here too — but a span cited as one subsection should be that subsection.
3. **With the plan as handed to this note, two prose defects — both applied, neither moving a
   number.** (a) *"the owner said twice that this change lands regardless of any host engine"* —
   he did not; §4.1 attributes it to the recording session's reading and keeps the §15.7 gate.
   (b) *"`62` §16.4 requires three things … (1) … (4)"* — four items for three requirements; §1.2
   and §5 present one mechanism and three requirements.
4. **With the six records' own version numbers.** Not a disagreement between two documents but
   between eight designs that never saw each other (RECOMMENDATIONS *Disagreements* item 10). This
   note is the resolution; the blocks in the record are left as they are and §8 carries the
   substitutions, because rewriting the record's YAML would hide what the skeptics reviewed.
5. **With reading this note's status as a decision on content.** Under `78` §7's test — *"if two
   reasonable people could do it differently and both be defensible, it is judgment-shaped"* — the
   order itself is judgment-shaped and is planning's, and it is marked DECISION (sequencing) for
   that reason. Everything it touches that a reasonable person could also decide differently *on
   the merits of the data model* is marked as not decided (§1.3, §6.2, §4.6). A reader who finds a
   content decision hiding in a sequencing sentence should treat it as a defect of this note, not
   as a decision taken.
