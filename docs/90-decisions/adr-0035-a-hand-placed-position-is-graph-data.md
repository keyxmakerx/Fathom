# ADR-0035 — A hand-placed position is graph data, stored as a `LayoutPin` on the element it places

> **Status:** **Accepted** — decided by the owner 2026-08-15, after the request had been made three
> times and refused three times for want of somewhere to put the answer. Binding under `CLAUDE.md`
> rule 3; reopenable on merit under `75` §2, never on sunk cost.
> **Date:** 2026-08-15
> **Register entry:** `75` §10 C-08 (moves from *Intent recorded*); `00-ROUTE-TO-WORKABLE.md` §4 item 2
> **Reversal cost:** R2 — one kind, one edge, one class and two field keys in `schema/`; the keys are
> retired and never reused if it is reversed, and any workspace written in the meantime carries pins
> a later build would have to ignore rather than misread
> **Supersedes:** — amends `56` §3.5 and closes the *Undecided* in
> `docs/70-ops/79-work-orders/00-ROUTE-TO-WORKABLE.md` §4 item 2; supersedes no ADR

## Contents

| § | |
|---|---|
| 1 | The request, and what was actually blocking it |
| 2 | The decision |
| 3 | Why a position is graph data and not a view preference |
| 4 | The shape: why a dedicated kind and not a field per kind |
| 5 | The separation that must survive: computed layout, hand override, visibly marked |
| 6 | What was built |
| 7 | What it cost, measured |
| 8 | Failure modes |
| 9 | Open decisions |
| 10 | Sources consulted |
| 11 | Disagreements |

---

## 1. The request, and what was actually blocking it

The owner has asked for this three times, in his own words (`70`):

> *"drag a device then I can in its inventory set the device type model and other info"*
> *"we should be able to add into inventory by just drag and drop"*
> *"didn't we agree we were gonna have a drag and drop system?"*

The form half shipped — `OP_EQUIP_ADD` and `OP_FIELD_SET`, the second door into the estate. The
canvas half did not, and the reason given each time was the same, most recently in
`00-ROUTE-TO-WORKABLE.md` §4 item 2:

> *"there is nowhere in `schema/` to store where a box sits; `56` §3.5's `LayoutHint` is prose in a
> design doc, and it may deliberately belong outside the typed graph as a view preference.
> Undecided, and a dragged box cannot survive a reload until it is."*

That sentence is accurate about the state and wrong about the difficulty. The blocker was never
engineering; it was one unmade decision, and it was handed back to the owner three times as an
architecture question. This record makes it, so it stops being asked.

## 2. The decision

> **DECISION — a hand-placed position is graph data.** It is stored in `schema/`, with
> `Origin::Hand` provenance, like every other thing a person asserts. It is written by an op
> (`OP_PLACE`), journalled like every other op, and it survives an export and an import.
>
> It is stored as a **`LayoutPin` node contained by the element it places**, carrying two
> integer fields `x` and `y` on `56` §3.5's 4 px grid, reached by the containment edge
> `HasLayoutPin` from the new `Placeable` class.
>
> **It is an override, never the source of position.** `fathom-layout` remains the source of
> position for every unplaced element; a placed element sits where the person put it **and the
> picture says it was placed by hand.**

## 3. Why a position is graph data and not a view preference

Four arguments, and the fourth is the one that closes it.

**A diagram an engineer arranged and cannot keep is not worth arranging.** A view preference does
not survive export, import, or being handed to a colleague — which is the whole point of drawing
one. `16` §1.1 already makes the same argument about determinism and change tickets: a picture is
worth something because it can be *given to somebody*. An arrangement that evaporates on reload is
not an arrangement, it is a fidget.

**`Origin::Hand` is the first variant of the provenance enum and exists for exactly this.** A fact a
person asserted, distinguishable forever from one a config stated. *"The engineer says this box goes
here"* is that kind of fact — it is not more or less true than `hostname srx-branch-01`, it is
differently sourced, and the enum's whole job is to keep that distinction legible. `11` §8.3 is
explicit that confidence measures *how directly the thing was observed*, not how much the source is
trusted, so a hand position is `Confidence::Asserted` exactly as a hand-entered hostname is.

**`75` §2.4 forbids new state that forecloses real-time collaboration, and it names the failure
mode: *"state written beside the op log"*.** A position stored outside the graph **is** that state.
Two people opening one workspace would have two arrangements, neither convergeable, and the CRDT
work would arrive to find a whole feature it cannot see. A position stored **in** the graph is one
more op a CRDT converges — and `56` §3.5 has already thought about the conflict case and answered
it: *"the position is a class B last-write-wins field under `33` §6.4"*.

**ADR-0008: a field not in `schema/` does not exist.** There is no third place. Once the first three
arguments rule out side-state, the only remaining question is *what shape in `schema/`*, which is
§4.

### The rejected alternative, stated plainly

**Rejected: a view preference, held in the page and persisted to `localStorage`.** It is cheaper —
zero module bytes, zero schema, an afternoon — and it is what most tools do. It is rejected because
every one of its three failure modes is silent:

| It fails | And the user learns | |
|---|---|---|
| on export | never — the file looks complete | The colleague opens a workspace whose diagram is not the one that was described to them |
| on a second machine | never | Same workspace, different picture, no message |
| under collaboration | never, until the CRDT lands and the arrangements diverge | `75` §2.4's exact prohibition |

A cheap feature whose failures are invisible is more expensive than an honest one. And the price
turned out to be small: §7.

## 4. The shape: why a dedicated kind and not a field per kind

`56` §3.5 says the hint is *"attached to any node that can be drawn"*. Two shapes can spell that in
`62`'s grammar and they are not close.

**Rejected: a `scene_position` field on every drawable kind.** Forty-eight kinds, forty-eight field
keys — or ninety-six if `x` and `y` are separate — and the killing objection is mechanical rather
than aesthetic: **a field key is per `(kind).field`, so the key differs on every kind.** Generic code
— `fathom-layout`, which is handed a `NodeId` and must ask *"does this have a position"* — would
need a forty-eight-arm kind-to-key table, or a `format!("{kind}.scene_position")` string built per
node per layout and looked up in the 299-arm canon table. Both are worse than the thing they buy.
The secondary objection is a product one and it also stands: a network engineer opening a `Device`
inspector should not find `scene_position` sitting among `hostname`, `platform` and `os_version`. A
fact about the drawing is not a fact about the device.

**Chosen: one `LayoutPin` kind, contained by the element it places.**

| Decision | Reason |
|---|---|
| A **node**, not a field | One field key pair for the whole schema, and the same key on every subject, so `fathom_layout::pin_of` is four lines and knows nothing about kinds |
| **Contained**, not referenced | `Graph::tombstone` takes the subtree, so removing a device takes its pin. A pin for a box that is gone is not a fact anybody asserted — the same argument `OP_ELEMENT_REMOVE` already makes about a chassis |
| `out: "0..1"` | Two positions for one box is unrepresentable rather than merely unwritten |
| `identity: []` | A pin is identified by what contains it and by nothing else. A natural key like `owner + x` would make *moving* a box change its identity |
| Two `i32` fields, not one structured value | The store's primitive path is already generated for `i32`; a structured `ScenePoint` would need a new value type in `fathom-ir` for no gain. Integers and never floats — invariant 9 |
| A `Placeable` **class**, written out | `62` §6.2 expands a class into endpoint kinds at codegen, so one edge declaration covers forty-eight pairs. The list is data and is pinned by a test (§6) so a kind added later cannot silently become unplaceable |

**`LayoutPin` is excluded from the drawing in exactly one place** — `fathom_layout::agg::live_nodes`
— because `at`, the node-to-box map every later stage indexes, is built from that list. Ordering,
routing and the aggregation signature therefore never see a pin, by construction rather than by
three filters that could disagree.

## 5. The separation that must survive

`56` §3.5's rule is not negotiable and is restated here because it is the part most likely to erode:

> **Layout is COMPUTED. A hand position is an OVERRIDE, and the picture says which boxes carry one.**

`lay_out_with` runs the rank walk, the crossing reduction and the row assignment **untouched**, and
applies the override afterwards. Two consequences worth having:

- An estate with no pins lays out byte-identically to one from a build that had never heard of them.
- A pin moves one box and changes nothing else — `56` §3.5's second property (*"I moved one box and
  the whole picture rearranged"*) obtained by construction.

**A collapsed group cannot be placed.** A box standing for forty nodes has no single element whose
position it could be; `pin_of` is consulted only when the cell holds exactly one node, which is the
same rule that makes `Cell::key` postable only at count 1. Dragging a collapsed group pans instead.

### The mark, and the channel argument for it

`56` §5.2 says of the picture's channel budget: *"one channel, one meaning, and nothing may be added
to it without taking something away."* Every channel that table gives a **node** is spent — G1
boundary tone is freshness, G2 boundary dash is AI-proposed (`51` §9, product-wide, and `dotted` is
pending, so both line styles are gone), G3 boundary weight is selection, G8 the second label line is
age in words. The mark therefore takes **none of them**: it is a separate stroked corner tick plus
the word `placed`, which is the same move `59` §3.5 made for the aggregation stack after checking
the same table.

Four ways of saying it, degrading in different directions:

| Where | Survives |
|---|---|
| a stroked L at the box's top-left corner | forced colours, greyscale, monochrome print, every level of detail |
| the word `placed` in the box | being read aloud; dropped only at LOD 0, with the node name |
| `placed by hand` on the **Outline row** | assistive technology — the only one of the four that does, because the `<svg>` is `aria-hidden` (`55` §4.5.2) |
| the count in the view band's note | `56` §5.2 G10, the release valve |

## 6. What was built

| Layer | |
|---|---|
| `schema/schema.yaml` | class `Placeable` (48 members), kind `LayoutPin` (`x`, `y`), edge `HasLayoutPin` |
| `schema/field-keys.yaml` | `LayoutPin.x: 300`, `LayoutPin.y: 301`, appended, never reused |
| `fathom-layout` | `Node::placed`; `pin_of`, `pin_node`, `snap`; the override in `lay_out_with`; the extent widened to hold a dragged box; `LayoutPin` dropped from `live_nodes` and given a drawn-nowhere arm in `layers::projection_of` |
| `fathom-wasm` | `OP_PLACE = 21`, mode 0 releases and mode 1 places; slot 7 of `FACE_BOX` gains the placed flag before the group key |
| the page | drag a box, four place buttons, `Alt`+arrow from the Outline row, *let the layout place it*, the mark, the row, the note, the journal op and its import arm |
| tests | `fathom-wasm/tests/place.rs` (8), `fathom-layout/tests/layout.rs` (6), `fathom-schema/tests/shipped_tree.rs` (1, the `Placeable` drift guard) |
| evidence | `docs/80-review/evidence/2026-08-15-hand-placement-drive.mjs` — 25/25 in Chromium, including a real reload between export and import |

## 7. What it cost, measured

Measured, not estimated, `wasm32-unknown-unknown` release, 2026-08-15:

| | bytes |
|---|---|
| before | 896,097 |
| after | 897,082 |
| **the whole feature** | **+985** |
| headroom against `44` §5.2's 900,000 | 2,918 |

The page work is artifact bytes, not module bytes: the artifact moved 2,263,247 → 2,264,104 against
a 4.5 MB budget.

**+985 is worth stating against the alternative that was refused.** `47` §11 refused the config view
at +93,838, and `00-ROUTE-TO-WORKABLE.md` §4 priced *"drag on a canvas"* at **stage 8, months**. The
months were the diagram, and the diagram landed on 2026-08-15. What was left, once the decision was
made, was under a kilobyte.

## 8. Failure modes

| Failure | What happens | Why that is the least bad |
|---|---|---|
| A pin exists whose subject was tombstoned | The pin is tombstoned with it — containment cascade | A pin for a box that is gone is not a fact anybody asserted |
| A pin has `x` and no `y` | Treated as no pin at all; the layout places the box | Falling back to the computed coordinate for one axis would draw the box somewhere nobody chose *and mark it as chosen* |
| Two pins on one element | Unrepresentable — `HasLayoutPin` is `out: "0..1"` and the store refuses the second | |
| A member of a collapsed group is pinned | Ignored while the group is collapsed; honoured the moment it is drawn alone | The alternative moves thirty-nine boxes nobody touched |
| The host reuses entropy across two ops | The store refuses the second as `ProvenanceIdReused` | The refusal is correct and loud. `place.rs`'s helper documents it after being written the wrong way first |
| An older build opens a workspace with pins | It replays `OP_PLACE` as an unknown op and refuses the import, naming the step | `11` §11's forward-compatibility problem, unchanged by this record and not solved by it |
| `layer: config` on `LayoutPin` | Nothing today; the four consumers `62` §4.2 names are unbuilt | Named as a gap in §9 rather than hidden. `emits: false` closes the emit consumer, and a pin is never produced by a capture, so re-identification cannot reach one |

## 9. Open decisions

1. **`62` §4.2's `layer` vocabulary has no true value for a view fact.** `config | physical |
   service` are the network's three layers and a pin belongs to none. `config` is transcribed as the
   conservative reading with the reasoning in `schema.yaml`; a fourth value is a `62` amendment and
   this record is not the one to make it. **For `62`'s owner.**
2. **`Alt`+arrow is bound in the page as an accelerator and `53` owns the keymap** (ADR-0024). It is
   never the only path — the four place buttons are ordinary focusable controls and do everything it
   does, which is the same posture the page already takes for continuous zoom (`53` §3.4 binds only
   `z`; `+`/`-` were deliberately not invented). `53` §4.4 names `Alt`+arrow as unclaimed by macOS
   and the major Linux desktops and as this keymap's namespace for shell and structure. **For `53`
   to ratify or move.**
3. **`56` §3.5's other three pin forms are not built.** `Pin::InLayer`, `Pin::Grouped` and
   `pinned_under` are specified there and only `Pin::At` ships. The schema takes the others
   additively — a `mode` field and a rank on `LayoutPin` — and nothing here forecloses them.
4. **The nudge step is 20 scene units**, five grid squares. A judgement, not a measurement: 4 px is
   correct and invisible at fit zoom on any real estate.
5. **Undo.** The batch labels are written (`Place a box on the diagram`, `Let the layout place it
   again`) and there is no undo stack in the product yet, for placement or for anything else. `56`
   §3.5 expects `Ctrl+Z` to restore pins *"because the pin change is an op like any other"* — which
   it now literally is, so this feature costs the undo work nothing.

## 10. Sources consulted

| Source | For |
|---|---|
| `docs/50-design/56-diagram-view.md` §3.5, §3.6, §5.2, §5.3 | `LayoutHint`, the computed/override separation, the channel budget, the 4 px grid |
| `docs/50-design/51-design-tokens.md` §9 | `dashed` reserved for proposed, `dotted` for pending — both unavailable |
| `docs/50-design/55-accessibility.md` §4.5.2 | focus never enters the `<svg>`; the Outline is the interface |
| `docs/50-design/59-diagram-aggregation-and-colour.md` §3.5, §3.6 | the precedent for adding a node channel with the table checked first |
| `docs/10-core/11-ir-schema.md` §3.2, §8.3, §10.5, §10.6 | node fields never hold a `NodeId`; confidence is directness; tombstones; *"Diagram position and layout — survives a rename, keyed by `NodeId`"* |
| `docs/60-content/62-schema-spec.md` §2.3, §4.2, §6.2, §17.1 | the YAML subset, the layer vocabulary, class expansion, the field-key registry |
| `docs/70-ops/75-capability-register.md` §2.4, §10 | *"state written beside the op log"*; C-08 |
| `docs/70-ops/79-work-orders/00-ROUTE-TO-WORKABLE.md` §4, §5b | the *Undecided* this closes; the journal route |
| `docs/40-stack/47-byte-census.md` §9.3, §11 | how a byte figure is quoted, and the precedent for refusing a feature on one |
| `.context/conventions.md` invariants 3, 7, 9 | credentials, opaque ids, determinism |

No vendor claim is made in this record, so ADR-0034's two-source rule does not engage. The one
number that could go stale — the module size — is dated, and `scripts/byte-census.sh` reproduces it.

## 11. Disagreements

**With `00-ROUTE-TO-WORKABLE.md` §4 item 2, on the estimate rather than on the fact.** That document
is right that the decision was missing and right that a dragged box could not survive a reload
without it. Its estimate — *"Stage 8, months"* — attributed the cost to the wrong thing. The months
were the diagram view, and they were spent. Once the diagram existed, the placement was 985 module
bytes and one afternoon. The lesson is not that the estimate was careless; it is that **an
undecided question inside an estimate makes the estimate meaningless**, because nobody can tell
which part of the number is work and which part is waiting.

**With this record's own §4, filed against itself.** The `Placeable` class lists forty-eight kind
names, and that is a maintenance surface a class-of-everything should not need. The grammar has no
"any kind" endpoint token and `62` §6.2's class mechanism is the nearest thing to one. A test pins
the list against `kinds:` so the drift is a test failure rather than a silent gap — but the right
fix is a grammar token, and that is `62`'s to add.
