# ADR-0036 — Physical placement is graph data; a rack is a kind and mounting is a reference

> **Status:** **Proposed** — the schema half is executed and gated; the ladder's upper rungs are not.
> Binding under `CLAUDE.md` rule 2 once Accepted; reopenable on merit under `75` §2, never on sunk cost.
> **Date:** 2026-08-15
> **Owner request:** *"how do I go into rack Mount view?"*; `70` §10.5 verbatim — *"zoom out to be a
> rack, zoom out for a floor(s) with multiple floors and connections between them"*
> **Answers:** `56` §13.4's stated blocker — *"The rack / floor / building / map rungs need
> somewhere to live in the graph"*; `70` §10.8 cost 3; `19` §3.10 row 1
> **Reversal cost:** R2 — one kind, two edges, six field keys. Field keys are append-only and
> retire rather than recycle, so a reversal costs six retired integers and no stored bytes move.
> **Renumbered 0035 → 0036 on rebase**, and the number is the only thing that changed: ADR-0035 had
> been taken concurrently by *a hand-placed position is graph data*, which lands `LayoutPin` and
> `OP_PLACE`. The two are siblings and not rivals — that one says where a box sits on the DIAGRAM,
> this one says where it stands in the WORLD — and both are graph data for the same reason.
> **Supersedes:** — (amends nothing; `19` §3.10 predicted this edit and priced it)

## 0. Contents

1. What was decided
2. Why a rack is a kind, and not a `Premises` and not a `Site`
3. What a rack actually is — established, not assumed
4. Why the elevation is not the diagram
5. What this costs, measured — 5.1 whether it fits · 5.2 what the schema bump costs
6. What it deliberately does not do — 6.1 two faces, side by side · 6.2 the defect this replaces
7. Failure modes
8. Open decisions
9. Sources consulted
10. Disagreements
11. How this was verified

---

## 1. What was decided

**A hand-placed physical position is graph data.** It goes in `schema/`, with `Origin::Hand`
provenance, like every other thing a person asserts. Not a view preference, not side-state, not
`localStorage`.

Concretely, in `schema/schema.yaml` (version 0.1 → 0.2, a **minor** bump priced item by item
against `62` §16.2 in the file's own version comment):

| Declaration | Class | Shape |
|---|---|---|
| `kind: Rack` | `layer: physical`, `emits: false` | `label`, `height_u`, `unit_numbering`; identity `[ owner(Premises), label ]`. **No `notes`** — it was there in the first draft because every sibling physical kind has one, and nothing wrote it, read it, or offered it; a field key is assigned forever, so declaring one on the strength of a pattern spends an integer on a field that does not exist |
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

**RE-MEASURED ON THE TIP, AND THE NUMBER MOVED.** The first version of this table was measured
against `adbb590` and reported +17,533. Every row below was rebuilt after merging `d96cf95`, and the
same feature now costs **+21,392**. `47` §9.3's rule is why the table was rebuilt rather than
carried over: two deltas measured against different bases do not add, and this project has already
had one verdict reverse sign that way. The +3,859 difference is not drift — it is real work the
merge created, itemised below.

| Build | Bytes | Δ from the tip |
|---|---|---|
| The tip (`d96cf95`) | 862,368 | — |
| Everything but the two dispatch arms — schema, `InvKind::Rack`, `rack.rs`, the protocol codec | 865,162 | +2,794 |
| + the elevation read path (`OP_RACK_ELEVATION`) | 874,684 | +12,316 |
| + `OP_RACK_PLACE` — **as shipped** | 883,760 | **+21,392** |

Each row is its own build, not a subtraction: the middle rows were measured by removing only the
dispatch arm, so LTO drops what becomes unreachable. Read path = 874,684 − 865,162 = **9,522**.
Write path = 883,760 − 874,684 = **9,076**.

Four findings:

1. **The schema extension is nearly free, and it is no longer byte-NEUTRAL.** It measured 1,475
   bytes *under* baseline before the merge and +2,794 over the tip after it, and the reason is
   `Placeable`: ADR-0035's `HasLayoutPin` declares `from: [Placeable]`, so admitting `Rack` to that
   class adds a 49th containment pair, a `layers.rs` arm, and rows in the generated containment
   tables. **Adding a kind to `schema/` costs whatever the classes that mean "all of them" cost**,
   which was zero before a class like that existed. Worth knowing for every future kind.
2. **The face costs +21,392 module bytes**, split +9,522 read / +9,076 write, with +2,794 that
   belongs to neither. Read and write are not separable in practice: nothing but `OP_RACK_PLACE` can
   produce a placement, so shipping the renderer alone would ship a view that can only ever be empty.
3. **A rack is inventory, and saying so saved 1,866 bytes.** The first cut had a bespoke
   `OP_RACK_LIST`; making `Rack` an `InvKind` instead reuses `rows()` for four lines, gives the rack
   a real inventory row, and deletes a second way to ask the same question. (That figure is from the
   pre-merge measurement and is a *removal* delta, so it is quoted as the reason a thing is absent
   rather than as a row in the table above.)
4. **The renderer rewrite that fixed the vanishing box cost nothing in module bytes**, because it is
   entirely in the page. Two face columns, sub-lane packing and a declared grid are artifact bytes.
   §4's split paid for itself the first time the geometry had to change.

### 5.1 Whether it fits

**It fits: 862,368 + 21,392 = 883,760, which is 16,240 bytes under `44` §5.2's 900,000 ceiling.**

That is measured on the merged tree, not projected from an older base. `crates/fathom-wasm/tests/artifact_gates.rs`
is byte-for-byte untouched — one threshold, not feature-gated, not weakened.

**16,240 is not much, and the integrator should read it as a shared remainder rather than as this
feature's slack.** Two sibling sessions are competing for the same space this round. What can be
given back if it is needed, in the order it should be spent:

| Lever | Worth | What is lost |
|---|---|---|
| The write path (`OP_RACK_PLACE`) | 9,076 | Everything. The view can only ever be empty without it — not a lever, listed so nobody suggests it |
| `Slot.device` / owner-name resolution | unmeasured | The box would say `chassis 0` and not `srx-a`. Cheap to try, and it is the only fat visible |

There is no third. This face is small because the geometry is in the page.

Artifact bytes: `target/artifact/fathom-dev.html` went from **2,220,226** at the tip to **2,289,481**
— **+69,255** against `44` §5.5's 4.5 MB budget, which is 51% used. Most of that is the module
itself arriving base64-encoded at 4/3 size (21,392 × 4/3 ≈ 28,523); the rest is the face's own CSS
and JavaScript, including the whole of the elevation's geometry. Artifact bytes are the ample budget
and were spent deliberately in preference to module bytes wherever the choice existed — §4's last
paragraph.

### 5.2 What a 0.1 → 0.2 schema bump costs, which the first version of this section did not say

`schema/migrations/manifest.toml` moves to `schema_version = "0.2"` with `migrations = []`, so
**`read_plain` refuses every workspace file written by a 0.1 build, by name, on the header line
before the body is read.** The payload happens to be byte-identical across the bump — which is a
useful finding and beside the point, since the refusal happens first.

This is defensible and it is a decision, not an oversight: the manifest already records that the
empty chain is deliberate until the first release, nothing has been released, and `schema/released/`
holds no snapshot. What was wrong was the silence. It is written here so the first release cannot
inherit it as an unexamined habit: **the day something ships, a version bump needs a migration or a
stated refusal, and this paragraph is the precedent to point at.**

Note also that ADR-0035 added `LayoutPin`, `HasLayoutPin` and two field keys at 0.1 without bumping.
By `62` §16.2 that was itself a minor bump. This edit's 0.2 therefore covers both changes, and the
gap is named rather than quietly absorbed.

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
| ~~**Two faces drawn**~~ | **Now built — see §6.1.** The first cut drew one elevation and, worse, silently deleted a box mounted on the other face at the same U |
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
  two conflicting assertions is right, so **both are drawn, side by side in that face's column, and
  both are marked** in the picture rather than only in a caption. Opposite faces at the same U are
  *not* a clash: back-to-back mounting is normal.
- **Every box is either drawn or named, with the count.** The face prints
  *"N box(es) recorded in this rack; M drawn"* on every elevation, and lists in full, with the
  reason, any box the picture does not hold. §6.2 is why that sentence exists.

---

### 6.1 Two faces, side by side — what was established and what was decided

**Established, from two independent primary sources, both read 2026-08-15.** A rack elevation is
drawn PER FACE. NetBox's elevation endpoint takes one: *"the `face` parameter may be used to request
either the `front` or `rear` of the elevation"*
(`netboxlabs.com/docs/netbox/en/stable/release-notes/version-2.7/`). And a device type marked
full-depth *"is considered to occupy both the front and rear faces of a rack, regardless of which
face it is assigned"* (`netboxlabs.com/docs/netbox/models/dcim/devicetype/`) — a rule that only
means anything if the two faces are otherwise apart.

**Not established, and therefore decided here with the reasoning attached.** Neither source says
whether the two faces should be drawn *at the same time*. NetBox draws one and switches. This face
draws both at once, as two columns against one shared unit gutter, for a reason that is this
product's rather than the convention's: **a toggle hides half a rack behind an interaction**, and a
default of "front" would omit every rear-mounted box silently, by design, in a view whose one
prohibition is omitting something silently. Side by side, U5 front and U5 rear are one row and the
reader sees both without asking.

**A third column appears only when something is in it.** `MountedIn.face` is `card: "0..1"`:
somebody can know a box is at U12 without having said which side. Such a box may not be drawn on
the front, which would be a guess, nor across both, which is NetBox's specific full-depth claim and
a different assertion. It gets its own labelled column — `70` §16's rule that incomplete is drawn
and *marked*, never refused.

### 6.2 The defect this replaces, recorded because it shipped

The first renderer indexed placed boxes by the drawn row they start on — `starts[top] = s`, one slot
per row. **Any two runs beginning on the same row overwrote each other**, and the loser was drawn
nowhere, named nowhere, and present in no accessible-tree node. A companion line, `if (covered[row])
continue;`, then skipped creating the rows the vanished box had claimed, so a 42U frame drew 40.

Two cases reached it, and neither is exotic:

| Case | What happened |
|---|---|
| Front and rear at the same U — which §6 itself calls normal | One box gone, **no message of any kind**: opposite faces are correctly not a clash on the wire, so nothing fired |
| Two boxes overlapping on one face | One box gone — the *taller* one, deterministically — two units gone from the gutter, and the caption underneath printed *"Both are drawn"* |

**A rack elevation that silently drops a device is worse than no rack elevation.** `59`'s governing
rule is the same rule: a collapse that does not name what it hid is a lie with fewer elements.

Three things changed, and the third is the one that matters:

1. `starts` holds a **list per lane** rather than one slot, and boxes are packed into sub-lanes —
   each takes the first sub-lane whose runs it does not intersect. A box can no longer lose a race.
2. The frame is a **declared CSS grid**, `repeat(height, ...)`, so every unit row exists because the
   rack has that many units. A box is placed *into* it with `grid-row: n / span h` rather than
   consuming rows as the loop walks. A renderer bug can now draw a box in the wrong place; it can no
   longer delete a unit.
3. **The count is printed.** Recorded versus drawn, on every elevation, with every undrawn box named
   and given its reason. Arithmetic a reader can check without reading code — and so can a driver.

**Why the suite missed it, which is the more important finding.** Every collision assertion was on
the wire in Rust, and the page's geometry was checked by a *Rust re-implementation of the
JavaScript* — a `fn top_row` inside a test — which cannot see the renderer's maps at all. The
browser driver placed boxes only into distinct, non-overlapping units. Both suites passed at 100%
with the defect present. `docs/80-review/evidence/2026-08-15-rack-view-ax.mjs` now drives both
collision cases and asks the **accessible tree** how many boxes it can see; the Rust test carries a
paragraph saying plainly what it does not check.

---

## 7. Failure modes

| Failure | What happens | Guard |
|---|---|---|
| A rack's numbering is never stated | It cannot be drawn at all | `card: "1"` plus a refusal at `OP_RACK_PLACE` naming the field |
| A newer schema's numbering token reaches an older build | `elevation()` answers with **no direction** (`ascending: Option<bool>` = `None`), the wire's direction slot is empty, and the page draws **no frame at all** — it prints the token it could not read and names every box in words | `62` §7 rule 2; `crates/fathom-inventory/tests/rack_numbering.rs`; `the_direction_slot_tells_no_direction_apart_from_descending`. **This row asserted a guard that did not exist.** `elevation()` matched `_ => true`, so an unreadable token came out as *"ascending"* and the page drew the frame that way — the exact guess the no-default design exists to prevent. It is a type now, not a comment |
| A `range:` constraint is declared and enforced by nothing | `OP_RACK_PLACE` checks `1..=100` on the three unit-count fields at the door and names the field, the value and the declared range | **`fathom-schemagen` does not carry `range:` into the generated types at all** — a project-wide gap this edit is the first to lean on. `the_declared_range_is_the_range_the_door_enforces` reads the declaration out of `schema/schema.yaml` and fails if the door and the schema drift. Teaching the generator is the right fix and is filed |
| A store error part-way through `rack_place` | `Graph` has no rollback, so `end_batch` commits what was written and an orphan `Rack` can survive a refusal. **Named, not fixed**: the doc comment says so, the orphan is visible in the inventory and removable, and building the rollback is a `fathom-graph` change | Filed for planning. The earlier comment claimed "a refusal leaves the estate exactly as it was" without qualification, which was true of field refusals and false of this |
| Two placed boxes start on the same drawn row | Both are drawn, in side-by-side sub-lanes, both marked; the frame keeps its full height | §6.2. Driven in `2026-08-15-rack-view-ax.mjs` §§10–11 against the accessible tree |
| `position_u` near 255 with a tall box | `last_u()` saturates rather than wrapping into a low number and appearing to sit at the bottom of the frame | `saturating_add`; `Cargo.toml` keeps `overflow-checks` on in release |
| Two racks share a label | The lowest `NodeId` wins, deterministically | Sorted before `first()` (invariant 9) |
| A rack with no label matches another with no label | Cannot happen: `rack_label` returns `Option`, and `value_cell`'s `—` rendering is never compared | `fathom_inventory::rack_label` is separate from `value_cell` for exactly this |
| A second placement silently resizes the frame | Cannot happen: on reuse the supplied `height_u` and `unit_numbering` are ignored, not applied | `a_second_placement_cannot_resize_the_frame` |
| An `InvKind` wire byte is derived from `ALL.len()` | It silently means a different kind after an append. **This happened**: appending `Rack` after `Chassis` broke a `len() - 1` in `equip.rs` | Both the Rust tests and the page now look the kind up **by name**; `kind_byte()` / `kindByte()` |

---

## 8. Open decisions

1. ~~**Does the elevation draw two faces?**~~ **Decided — §6.1.** Both, side by side, plus a third
   column for a box whose face nobody stated. The per-face convention is established from two
   sources; drawing them simultaneously is this face's own decision and is argued rather than
   assumed. `56` still owns the question for the diagram's zoom ladder.
2. **Where does a rack sit in the diagram's zoom ladder once a diagram exists?** `56` §13.4. This
   ADR gives the rung a model; it does not decide the navigation.
3. **`HasRack` is `in: "1"` and nothing creates a `Premises`.** A rack with no premises is written
   today under `11` §7.2's upper-bound-at-write-time rule, exactly as a `Device` with no `Site` is.
   Whether the place tree should be *required* is `70` §10.8's question and is untouched.
4. **Should `Rack` carry a `form` (open frame, cabinet, wall-mount)?** Not added. Nothing traverses
   it and `19` §3.10's test says omit it.
5. **The move gesture.** Refused by name today; somebody must decide its undo semantics.
6. **`fathom-schemagen` should carry `constraints.range` into the generated types.** Three fields
   declare a range and the door enforces it from two hand-written constants pinned by a test. That
   is the right interim and the wrong permanent answer — §7 row 2.
7. **`Graph` has no rollback.** §7 row 3. Every batching writer in the tree shares the window, not
   just this one.

---

## 9. Sources consulted

| Source | Read | What it gave |
|---|---|---|
| `en.wikipedia.org/wiki/Rack_unit` | 2026-08-15 | 1¾ in / 44.45 mm; EIA-310, IEC 60297, Eurocard. **Silent on numbering direction** — recorded as a result |
| `en.wikipedia.org/wiki/19-inch_rack` | 2026-08-15 | 44.45 mm corroborated independently; 482.6 mm width; EIA-310-D (Sept 1992, REV E 1996); IEC 60297's full title; *"The industry-standard rack cabinet is 42U tall"*; no standard for depth |
| `netbox.readthedocs.io/en/stable/models/dcim/rack/` | 2026-08-15 | *"commonly between 42U and 48U tall, but NetBox allows you to define racks of arbitrary height"*; the ascending/descending toggle |
| `netbox.readthedocs.io/en/stable/models/dcim/device/` | 2026-08-15 | The `face` field; *"the base rack unit in which the device is mounted"*; rack assignment is optional |
| `netboxlabs.com/docs/netbox/models/dcim/devicetype/` | 2026-08-15 | *"If selected, this device type is considered to occupy both the front and rear faces of a rack, regardless of which face it is assigned"*; *"Users can upload illustrations of the device's front and rear panels. If present, these will be used to render the device in rack elevation diagrams"* — §6.1 |
| `netboxlabs.com/docs/netbox/en/stable/release-notes/version-2.7/` | 2026-08-15 | *"the `face` parameter may be used to request either the `front` or `rear` of the elevation"* — an elevation is per face. §6.1 |
| `github.com/netbox-community/netbox` issue **#191** | 2026-08-15 | A real estate numbering top-down (*"U01 is at top of rack and U41 is at rack bottom"*) against NetBox's opposite default |
| `schema/schema.yaml` (`Chassis`, `Premises`, `PassiveNode`, `HasChassis`, `HasPremises`, `HasPassiveNode`, `AtPremises`) | 2026-08-15 | The containment shape this edit had to fit |
| `19` §3.3, §3.5, §3.6, §3.10; `62` §2.3, §4, §6, §7, §8, §16.2; `70` §10.7–10.9; `56` §13.4 | 2026-08-15 | The design already on record, including the row that predicted this edit |

---

## 10. Disagreements

**1. RESOLVED BY THE REBASE — the worktree now IS the tip.** This section previously recorded that
the brief's stated repository state did not match the base commit (`adbb590`: one live view, no
`fathom-layout`, 420 tests, 852,918 bytes) and that the byte figures differed by 43,179. `d96cf95`
has since been merged: `fathom-layout` exists and was read, the module measures 862,368 at the tip,
and every figure in §5 is measured on the merged tree. **Nothing in §5 is carried over from the old
base**, because two deltas measured against different bases do not add — `47` §9.3, and the reason
this project has already had a verdict reverse sign.

Two consequences of the merge are recorded rather than absorbed:

- **§4's note is discharged.** `crates/fathom-layout/` now exists and its `layers.rs` was read. The
  argument in §4 does not depend on its contents — it turns on the y axis being *given* rather than
  derived, which is a property of racks — and reading the crate did not change it. `Rack` was added
  to `projection_of`'s exhaustive match as UNTABLED, over-drawn and marked, by the same rule
  `Premises` and `PassiveNode` already follow: `56` §4.1 has no row for it, and confining it to the
  physical layer would read as a decision `56` has made and has not.
- **`Rack` joined the `Placeable` class**, which ADR-0035 introduced and which
  `shipped_tree.rs::every_kind_but_the_pin_itself_is_placeable` polices. A rack is a live node, so
  the diagram draws it as a box like any other, and a box you can see but cannot drag would be an
  arbitrary hole in that capability. It is also §5's finding 1: that class is what made adding a
  kind stop being free.

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

---

## 11. How this was verified

The floor, run in this worktree after the merge of `d96cf95`:

| Gate | Result |
|---|---|
| `cargo fmt --all --check` | silent |
| `cargo clippy --all-targets --locked -- -D warnings` | exit 0 |
| `cargo test --workspace --locked` | **598 passed, 0 failed, 0 ignored, 0 filtered** (573 at the tip) |
| `cargo run --locked -p fathom-schema --bin fathom-schema-check` | 50 kinds · 92 edges · 61 scalars · 10 enums · **0 failures, 0 warnings** |
| `./scripts/gate-zero.sh` | OK — every external package has an approval record (there are none) |
| `cargo run --locked -p fathom-artifact` | 2,289,481 bytes |
| release wasm | **883,760** against the 900,000 ceiling |

`crates/fathom-wasm/tests/artifact_gates.rs` is **byte-for-byte unchanged** against the tip
(`git diff` is empty): one threshold, not feature-gated, not weakened.

**Every driver in the tree was re-run and every one matches the tip check-for-check**, with one
exception in each direction:

- `2026-08-15-rack-view-ax.mjs` went **19/19 → 45/45**. The added sections drive the two collision
  cases against the accessible tree, the full-height frame, the count sentence, the named-not-drawn
  list and the range refusals.
- `2026-08-15-hand-placement-drive.mjs` fails **3 checks, and fails the same 3 with the same numbers
  on `d96cf95` itself** (`Alt`+arrow from the Outline row, the focus that follows it, and
  *"2 place ops of 3"* in the export). Pre-existing on the tip, untouched here, and named rather
  than quietly inherited.

One defect was found by that re-run and fixed, and it is the merge hazard the brief warned about in
its own words. Both sides of one HTML conflict ended on the same two closing tags, which git had
already merged *outside* the conflict — so concatenating the two sides nested `53` §6.2's layer-4
copy block **inside `#msheet`**, which carries `hidden`. `showCopyBlock`'s `focus()` then silently
did nothing and layer 4 became a panel you could see and could not copy from; the finder driver went
18/18 → 17/18 and said exactly which check. The fix moved the block back to being a sibling of the
sheets, and the DOM ancestry of every `id` in the built artifact was diffed against the tip's to
prove nothing else moved: the diff is my eleven new elements and nothing more.
