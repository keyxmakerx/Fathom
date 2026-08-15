# ADR-0035 — Physical placement is graph data; a rack is a kind and mounting is a reference

> **Status:** **Proposed** — the schema half is executed and gated; the ladder's upper rungs are not.
> Binding under `CLAUDE.md` rule 2 once Accepted; reopenable on merit under `75` §2, never on sunk cost.
> **Date:** 2026-08-15
> **Owner request:** *"how do I go into rack Mount view?"*; `70` §10.5 verbatim — *"zoom out to be a
> rack, zoom out for a floor(s) with multiple floors and connections between them"*
> **Answers:** `56` §13.4's stated blocker — *"The rack / floor / building / map rungs need
> somewhere to live in the graph"*; `70` §10.8 cost 3; `19` §3.10 row 1
> **Reversal cost:** R2 — one kind, two edges, seven field keys. Field keys are append-only and
> retire rather than recycle, so a reversal costs seven retired integers and no stored bytes move.
> **Supersedes:** — (amends nothing; `19` §3.10 predicted this edit and priced it)

## 0. Contents

1. What was decided
2. Why a rack is a kind, and not a `Premises` and not a `Site`
3. What a rack actually is — established, not assumed
4. Why the elevation is not the diagram
5. What this costs, measured
6. What it deliberately does not do
7. Failure modes
8. Open decisions
9. Sources consulted
10. Disagreements

---

## 1. What was decided

**A hand-placed physical position is graph data.** It goes in `schema/`, with `Origin::Hand`
provenance, like every other thing a person asserts. Not a view preference, not side-state, not
`localStorage`.

Concretely, in `schema/schema.yaml` (version 0.1 → 0.2, a **minor** bump priced item by item
against `62` §16.2 in the file's own version comment):

| Declaration | Class | Shape |
|---|---|---|
| `kind: Rack` | `layer: physical`, `emits: false` | `label`, `height_u`, `unit_numbering`, `notes`; identity `[ owner(Premises), label ]` |
| `edge: HasRack` | **containment** | `Premises → Rack`, `out: "0..n"`, `in: "1"` |
| `edge: MountedIn` | **reference** | `Chassis → Rack`, `out: "0..1"`, `in: "0..n"`; fields `position_u`, `height_u`, `face` |

Four reasons, and they are the ones to carry rather than re-derive:

1. **A diagram an engineer arranged and cannot keep is not worth arranging.** A view preference does
   not survive export, import, or being handed to a colleague, which is the whole point of drawing
   one.
2. **`Origin::Hand` is the first variant of the provenance enum and exists for exactly this** — a
   fact a person asserted, distinguishable forever from one a config stated. *"The engineer says
   this box goes here"* is that kind of fact.
3. **`75` §2.4 forbids new state that forecloses real-time collaboration**, and names the failure:
   *"state written beside the op log"*. A position stored outside the graph **is** that state. A
   position stored in it is one more op a CRDT converges, and persistence already journals ops.
4. **ADR-0008: a field not in `schema/` does not exist.** There is no third place to put it.

**The separation that survives, and it is `56` §3.5's:** layout is COMPUTED, and a hand position is
an OVERRIDE that is visibly marked as one. Nothing here changes that. A rack elevation is not a
computed layout at all (§4), so the override question does not arise inside it; where it will arise
is the network diagram, and this ADR does not touch that.

---

## 2. Why a rack is a kind, and not a `Premises` and not a `Site`

`70` §10.8 cost 3 posed the fork that has blocked the ladder's bottom three rungs since 2026-08-08:

> *"A rack that contains devices is therefore not expressible by nesting `Premises` alone — either
> `HasDevice` widens the way `HasExternalPeer` already did, or a rack is a `Site`. Nobody has
> decided which, and it is the load-bearing question under the ladder's bottom three rungs."*

**Both limbs are wrong, and they are wrong for the same reason: the thing in the rack is not the
device, it is the chassis.**

A Junos chassis cluster is one `Device` with two `Chassis` (`11` §6.3, and `schema/`'s `HasChassis`
is `out: "1..n"`). **Putting node0 and node1 in separate racks is the normal reason to have a cluster
at all** — a cluster whose two halves share a frame shares its failure modes. Containment is a
forest, so a `Device` has exactly one containment parent; a containment edge from a rack to a device
therefore *cannot express a split cluster*, and taking that limb would have made the model unable to
describe the single most common physical arrangement in the estate this product is for.

Widening `HasDevice` fails on that. "A rack is a `Site`" fails twice over: `Site` is `layer: config`
and `emits: true` (it carries `Site.timezone` at Emit `O`), and `19` §3.5 deliberately separates the
operational grouping (`Site`) from the physical location (`Premises`). A rack is neither an emitting
config object nor an operational grouping.

Nesting `Premises` — `70` §10.8's own proposal — fails on its own terms. It needs the `form` enum
widened with five values (cost 1), it turns `19` §3.5's two-hop sibling query into an ancestor walk
(cost 2), **and by its own cost 3 it still does not put devices in racks.** It does not solve the
problem it was proposed for. A `Premises` also carries a street address, a CLLI and coordinates; a
rack has none of those and has a height in units and a numbering direction, which is a different
kind with a different field set.

**The answer was already written and nobody had taken it.** `19` §3.10, row 1:

> *"**Rack** | No | `Chassis --MountedIn--> Rack` later is a new kind plus a reference edge = minor.
> Nothing in `77` traverses a rack. **Safe**"*

That is this edit, paid. `19` §3.10's own test — *"omit anything whose later addition is a minor
bump; never omit anything whose later addition would be a containment change"* — was applied
correctly in 2026-08 and holds now: nothing existing was restructured, and no kind's containment
owner changed.

**`MountedIn` must be a reference, and the codebase proves it.** `Chassis` already has a containment
parent (`Device`, via `HasChassis`). `crates/fathom-weld/tests/containment.rs` asserts that no
(owner, child) pair is carried by two containment edge kinds — so making `MountedIn` a containment
edge would have failed a test that has existed since WO-09, rather than shipping a broken forest.

**The placement fields sit on the edge, not on `Chassis`.** *"At U12, front"* is a fact about the
mounting, not about the box: a chassis on a shelf has no U. Putting them on the node would give every
unracked chassis three empty fields and make moving a box between racks a three-field edit rather
than one relation. Edges are first-class and carry typed fields (ADR-0007); `Link`, `Terminates` and
`Occupies` already do.

---

## 3. What a rack actually is — established, not assumed

ADR-0034 binds: none of this is answered from memory. Every claim below carries its source and the
date it was read.

| Fact | Value | Source, read 2026-08-15 |
|---|---|---|
| One rack unit | 1¾ in = **44.45 mm** | Wikipedia, *Rack unit*: *"A **rack unit** (abbreviated **U** or **RU**) is a unit of measure defined as 1+3⁄4 inches (44.45 mm)."* Corroborated independently by Wikipedia, *19-inch rack*: *"44.45 millimetres (1.75 in)"* |
| The standards | **EIA-310**, **IEC 60297** | Wikipedia, *Rack unit* and *19-inch rack*: EIA-310-D (September 1992, revised REV E 1996); IEC 60297 *"Mechanical structures for electronic equipment – Dimensions of mechanical structures of the 482,6 mm (19 in) series"* |
| Rack width | 19 in = **482.6 mm** | Wikipedia, *19-inch rack* |
| Rack height | **No standard.** 42U is the industry-standard cabinet; 42U–48U is the common range; arbitrary heights are real | Wikipedia, *19-inch rack*: *"The industry-standard rack cabinet is 42U tall"*. NetBox docs, *Racks*: *"Racks are commonly between 42U and 48U tall, but NetBox allows you to define racks of arbitrary height."* |
| Faces | Two, **front and rear** | NetBox docs, *Devices*: *"If installed in a rack, this field denotes the primary face on which the device is mounted."* |
| Which unit a multi-U box is recorded at | The **lowest-numbered** one it occupies | NetBox docs, *Devices*: *"If installed in a rack, this field indicates the base rack unit in which the device is mounted"*, with multi-U devices occupying their lowest-numbered unit |

### 3.1 The one that could not be established, and what was done about it

**U numbering direction has no universal convention, and the lookup is what proved it.**

1. **Wikipedia's *Rack unit* page defines the unit and is silent on direction.** Read 2026-08-15;
   nothing found. Per `.context/conventions.md` § *Currency* rule 1, *"nothing found"* is a result
   and is written as one.
2. **A real estate numbers the other way.** `netbox-community/netbox` issue **#191**, read
   2026-08-15: the reporter's Knurr racks are described as *"U numbering is from top to bottom :
   U01 is at top of rack and U41 is at rack bottom"*, and *"In NetBox it's inverted."*
3. **The mature DCIM in this domain ships the disagreement as a field.** NetBox docs, *Racks*, read
   2026-08-15: *"A toggle is provided to indicate whether rack units are in ascending (from the
   ground up) or descending order."*

Three sources, two of them independent of each other and of NetBox's default. Rule 2 of § *Currency*
is satisfied for the negative: this is not one database failing to answer.

**So the direction is not assumed, and is not defaulted.** `Rack.unit_numbering` is `card: "1"` with
no default, and `OP_RACK_PLACE` refuses a rack that does not state it.

That refusal is the point, and the brief anticipated it: *"Do not invent a numbering convention — if
you cannot establish one, say so and make the direction explicit in the model rather than implied."*
The reason it matters more than it looks: **an elevation drawn the wrong way up is wrong in every
position while looking entirely plausible.** A wrong field usually looks wrong; a rack drawn upside
down looks like a rack. That is precisely the silent wrongness `56` §0 exists to prevent — *"IF A
FACT EXISTS ONLY IN THE PICTURE, THE PICTURE HAS BECOME THE DATA STRUCTURE"* — and the honest lookup
produced a better model than a confident guess would have.

`ascending` (U1 at the floor) is the more common convention. It is **not** the default, and the enum
declares the two variants in that order only because declaration order is generated-enum order
(`62` §2.3), never because one is assumed.

---

## 4. Why the elevation is not the diagram, and is not built inside it

`crates/fathom-inventory/src/rack.rs` is a separate projection with its own renderer. The reasoning,
recorded because the alternative is superficially attractive:

**In a layered (Sugiyama) network layout the y coordinate is COMPUTED** — a rank derived from edges,
meaningful only relative to the other nodes, and free to move when a neighbour arrives.

**In a rack elevation the vertical axis IS the model.** U12 means U12 whether or not anything else is
in the frame, and it means the same U12 tomorrow when six more boxes land. Feeding a given position
into a layout that computes positions has two outcomes and both are wrong: the layout overrides the
datum and the fact is lost, or every node is pinned and the layout is an identity function wrapped in
crossing-reduction machinery that is paid for in module bytes and never used.

**The decisive third reason: a rack's EMPTY units are information.** *"Is there room for this box,
and where"* is most of what an elevation is consulted for. A graph layout has no concept of an empty
position — it draws nodes and the edges between them. The gaps in an elevation are drawn because the
grid is drawn, not because anything occupies them.

**Chosen: a separate renderer over the same graph. Rejected: reusing the layered layout.**

> **NOTE FOR THE INTEGRATOR.** The brief asked for `crates/fathom-layout/` to be read before this
> was decided. **That crate does not exist at this worktree's base commit** (`adbb590`,
> 2026-08-11) — see §10 disagreement 1. The reasoning above is therefore argued from `56` and from
> what a layered layout is, not from that crate's source, and should be re-checked against it at
> integration. The conclusion does not depend on its contents: it turns on the y axis being given
> rather than derived, which is a property of racks.

**And the drawing lives in the page, not in Rust.** The module returns `position_u`, `height_u` and a
direction; turning those into a row index is one subtraction. Page bytes are ARTIFACT bytes (`44`
§5.5's 4.5 MB budget, about half spent) while the module is measured against `44` §5.2's
900,000-byte ceiling with four figures of headroom. `fathom-inventory`'s rule that *"the page
computes nothing"* is about joins, walks and counts — every one of which still happens in Rust. A
coordinate transform over numbers already decided is not a join.

**The elevation is drawn in real DOM, not in an `<svg>`.** A network diagram needs vector: it has
edges, curves and routing. A rack is a stack of equal-height rows, which is a list. Drawn as a list,
every placed box is a real `<button>` in the accessible tree with a real name — rather than a
`<rect>` inside an `aria-hidden` picture with a parallel disclosure contract bolted alongside that
announces nothing when it drifts. `docs/80-review/evidence/2026-08-15-rack-view-ax.mjs` asserts this
against Chromium's **accessibility tree**, not the DOM.

---

## 5. What this costs, measured

Every figure below was measured in this worktree with
`cargo build --locked --release --target wasm32-unknown-unknown -p fathom-wasm --target-dir target/measure`.
**Nothing here is an estimate.**

| Build | Bytes | Δ from baseline |
|---|---|---|
| Baseline (`adbb590`, before any edit) | 852,918 | — |
| Schema only (`Rack`, `HasRack`, `MountedIn`, codegen regenerated) | 851,443 | **−1,475** |
| Schema + elevation read path (`OP_RACK_ELEVATION` only) | 862,390 | +9,472 |
| Schema + read + `OP_RACK_PLACE` — **as shipped** | 870,451 | **+17,533** |
| *(discarded)* the same with a bespoke `OP_RACK_LIST` | 872,317 | +19,399 |

Each row is its own build, not a subtraction: the read-path row was measured by removing only the
`OP_RACK_PLACE` dispatch arm so LTO drops the write path. Write path = 870,451 − 862,390 = **8,061**.

Three findings:

1. **The schema extension is byte-neutral.** It measured 1,475 bytes *under* baseline, which is
   inlining noise in the direction of smaller. **Adding a kind and two edges to `schema/` is
   free.** That is worth knowing for every future schema edit. (A byte census is said to exist at
   a later commit as `docs/40-stack/47-byte-census.md`, carrying a rule that a figure within
   ~2,000 bytes of a threshold is not a verdict. **It is not in this worktree** — see §10
   disagreement 1 — so it is described rather than cited, and the integrator should re-anchor
   this paragraph to it.)
2. **The face costs +17,533 module bytes**, split +9,472 read / +8,061 write. Those two are not
   separable in practice: nothing but `OP_RACK_PLACE` can produce a placement, so shipping the
   renderer alone would ship a view that can only ever be empty.
3. **A rack is inventory, and saying so saved 1,866 bytes.** The first cut had a bespoke
   `OP_RACK_LIST`; making `Rack` an `InvKind` instead reuses `rows()` for four lines, gives the rack
   a real inventory row, and deletes a second way to ask the same question.

### 5.1 Whether it fits

**At this worktree's baseline it fits with room: 852,918 + 17,533 = 870,451, which is 29,549 bytes
under the 900,000 ceiling.**

**Against the tip the brief describes — 896,097 used, 3,903 free — it does not fit, and misses by
13,630.** That is stated plainly rather than softened. It is not a refusal on measurement of the
kind this project has made before (the config view, refused because it could not fit *after every
lever was spent*): this one fits comfortably inside the ~35,000 bytes the sibling session is
freeing, consuming half of it. **The integrator decides, and needs to weigh it against two other siblings competing for
the same space.** The number to weigh is 17,533.

Artifact bytes: `target/artifact/fathom-dev.html` went from **1,215,578** to **1,264,072** —
**+48,494** against `44` §5.5's 4.5 MB budget (28% of it used). Most of that is the module itself
arriving base64-encoded at 4/3 size (17,533 × 4/3 ≈ 23,377); the rest is the face's own CSS and
JavaScript. Artifact bytes are the ample budget and were spent deliberately in preference to module
bytes wherever the choice existed — §4's last paragraph.

---

## 6. What it deliberately does not do

**Nothing parses a rack, and that is a fact about the world rather than a gap in the dictionary.**
No Junos statement — none this project has established, on any platform — says which rack a box
stands in or at what height. Every `Rack` and every `MountedIn` is `Origin::Hand`. **Hand placement
is the only input this can have today**, which makes the rack face a sibling of the hand-authoring
door (`OP_EQUIP_ADD`) rather than a parser feature. The face says so in the page, unprompted.

| Not built | Why |
|---|---|
| **Floor, building, map** | `56` §13.4's upper rungs. Each needs its own model decision and none is made here. The ladder's bottom rung is built; the rest stay proposals |
| **Two faces drawn** | Front and rear are RECORDED per box and shown in the label; the picture draws one elevation. Drawing two is a design question `56` owns |
| **Moving a box** | `MountedIn` is `out: "0..1"`. A move is a different gesture with a different undo label; re-placing a placed box is refused **by name** rather than silently re-pointed |
| **Depth, width, power, PDUs** | `19` §3.10 refuses power in writing and the reasoning stands. Depth and width are unmodelled |
| **Inferring placement** | Refused outright. A face that infers placement it does not know is worse than no face |
| **A seventh view** | A rack is a rung inside `56` §13.4's zoom ladder, not a peer of the six. It ships as a sheet and does not touch `data-view`, which is the view tabs' selector and therefore an API |

Three things the face does that are worth naming, because each is a refusal to launder an absence:

- **An unstated `height_u` stays unstated.** It is drawn as one unit and *marked* — never stored or
  reported as 1U. "1U" and "nobody measured it" are different claims.
- **A box recorded outside the frame is named, never clipped.** A 42U rack holding a box at U48 is a
  data error somebody must see; drawing it at U42 would destroy the evidence while looking tidy.
- **Two boxes in one unit are reported, not resolved.** This face has no basis for choosing which of
  two conflicting assertions is right. Opposite faces at the same U are *not* a clash: back-to-back
  mounting is normal.

---

## 7. Failure modes

| Failure | What happens | Guard |
|---|---|---|
| A rack's numbering is never stated | It cannot be drawn at all | `card: "1"` plus a refusal at `OP_RACK_PLACE` naming the field |
| A newer schema's numbering token reaches an older build | The generated `Unknown(token)` arm; the token is carried to the page and printed rather than treated as ascending | `62` §7 rule 2 |
| `position_u` near 255 with a tall box | `last_u()` saturates rather than wrapping into a low number and appearing to sit at the bottom of the frame | `saturating_add`; `Cargo.toml` keeps `overflow-checks` on in release |
| Two racks share a label | The lowest `NodeId` wins, deterministically | Sorted before `first()` (invariant 9) |
| A rack with no label matches another with no label | Cannot happen: `rack_label` returns `Option`, and `value_cell`'s `—` rendering is never compared | `fathom_inventory::rack_label` is separate from `value_cell` for exactly this |
| A second placement silently resizes the frame | Cannot happen: on reuse the supplied `height_u` and `unit_numbering` are ignored, not applied | `a_second_placement_cannot_resize_the_frame` |
| An `InvKind` wire byte is derived from `ALL.len()` | It silently means a different kind after an append. **This happened**: appending `Rack` after `Chassis` broke a `len() - 1` in `equip.rs` | Both the Rust tests and the page now look the kind up **by name**; `kind_byte()` / `kindByte()` |

---

## 8. Open decisions

1. **Does the elevation draw two faces, or one with a face label?** `56` owns it. One is built.
2. **Where does a rack sit in the diagram's zoom ladder once a diagram exists?** `56` §13.4. This
   ADR gives the rung a model; it does not decide the navigation.
3. **`HasRack` is `in: "1"` and nothing creates a `Premises`.** A rack with no premises is written
   today under `11` §7.2's upper-bound-at-write-time rule, exactly as a `Device` with no `Site` is.
   Whether the place tree should be *required* is `70` §10.8's question and is untouched.
4. **Should `Rack` carry a `form` (open frame, cabinet, wall-mount)?** Not added. Nothing traverses
   it and `19` §3.10's test says omit it.
5. **The move gesture.** Refused by name today; somebody must decide its undo semantics.

---

## 9. Sources consulted

| Source | Read | What it gave |
|---|---|---|
| `en.wikipedia.org/wiki/Rack_unit` | 2026-08-15 | 1¾ in / 44.45 mm; EIA-310, IEC 60297, Eurocard. **Silent on numbering direction** — recorded as a result |
| `en.wikipedia.org/wiki/19-inch_rack` | 2026-08-15 | 44.45 mm corroborated independently; 482.6 mm width; EIA-310-D (Sept 1992, REV E 1996); IEC 60297's full title; *"The industry-standard rack cabinet is 42U tall"*; no standard for depth |
| `netbox.readthedocs.io/en/stable/models/dcim/rack/` | 2026-08-15 | *"commonly between 42U and 48U tall, but NetBox allows you to define racks of arbitrary height"*; the ascending/descending toggle |
| `netbox.readthedocs.io/en/stable/models/dcim/device/` | 2026-08-15 | The `face` field; *"the base rack unit in which the device is mounted"*; rack assignment is optional |
| `github.com/netbox-community/netbox` issue **#191** | 2026-08-15 | A real estate numbering top-down (*"U01 is at top of rack and U41 is at rack bottom"*) against NetBox's opposite default |
| `schema/schema.yaml` (`Chassis`, `Premises`, `PassiveNode`, `HasChassis`, `HasPremises`, `HasPassiveNode`, `AtPremises`) | 2026-08-15 | The containment shape this edit had to fit |
| `19` §3.3, §3.5, §3.6, §3.10; `62` §2.3, §4, §6, §7, §8, §16.2; `70` §10.7–10.9; `56` §13.4 | 2026-08-15 | The design already on record, including the row that predicted this edit |

---

## 10. Disagreements

**1. The brief's stated repository state does not match this worktree, and the byte figures differ by
43,179.** The task described three live views (inventory, diagram, finder), a `crates/fathom-layout/`
crate, 557 tests and a module at 896,097 bytes with 3,903 free. This worktree's base commit
(`adbb590`, 2026-08-11) has **one** live view, **no** `fathom-layout`, **420** tests, and a module at
**852,918** bytes. There is also no `scripts/gate-zero.sh`, no `scripts/byte-census.sh` and no
`scripts/drive-*.mjs`, so three of the named floor commands and the named regression drivers do not
exist here.

Every number in §5 is measured against what is actually present and is labelled as such. **The
+17,533 delta is the figure that transfers**; the absolute totals do not. The `fathom-layout`
consequence is recorded in §4's note.

**2. `19` §3.10 says *"Nothing in `77` traverses a rack"* and that is still true.** This ADR adds the
kind anyway, on the owner's direct request. The `19` §3.10 test was about *omission being safe*, not
about addition being forbidden, so nothing is contradicted — but a reader comparing the two documents
should see that the justification here is a stated requirement, not a traversal need.

**3. `MountedIn` is the first edge in this project whose fields anything reads, and
`fathom-schemagen` generates accessors for kinds only.** `rack.rs` reads them through
`bag::typed` against a `FIELD_KEYS` lookup by declared name — which is exactly what a generated
accessor's body is, so ADR-0008 holds and no integer is hand-copied. **The generator should learn to
emit edge accessors**, and it is not done here because it edits a shared generator while three
sibling sessions are in flight. Filed for planning, not for an execution session.
