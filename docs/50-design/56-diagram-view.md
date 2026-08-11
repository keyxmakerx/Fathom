# 56 — The diagram view

> **Status:** Proposed

Companion documents: `.context/design-language.md` (the idiom this view has to be drawn in — no
icons, no colour beyond the risk enum, hairlines and mono), `10-core/11-ir-schema.md` §6–§8 (the
kinds, edges and provenance this view projects), `50-design/51-design-tokens.md` §4, §9, §12 (the
channel budget, the three rule weights, and the fact that a dashed rule already means something),
`50-design/52-information-architecture.md` §3.6, §5 (the view's place in the shell and the
selection model it participates in), `50-design/53-interaction-and-keyboard.md` (**the sole
owner of the keymap** per R11, ADR-0024 — this document binds no keys),
`50-design/55-accessibility.md` §4.5 (the Outline — which is
this view's keyboard and screen-reader interface and is not optional), `40-stack/41-technology-choices.md`
§4.5b (layout in the core, SVG in the UI, hit-testing in TS), `40-stack/44-performance-budgets.md`
§4.7 (B12, B13, the 2,000-element ceiling), `30-security/34-browser-hardening.md` §5.6 (the closed
SVG tag set and the export rules), `10-core/17-workspace-format.md` §15 (the plaintext export gate
this view's exports must pass).

Owner brief §6.5, in full, because every decision below is a reading of it:

> *"A view over the graph and a manipulation surface for it. Physical ports, logical links,
> tunnels, zones. Layered: physical / L2 / L3 / security / overlay, toggled independently.
> **Scope it as a design tool, not a source of truth.** Drawing what you are about to build, and
> getting validated configuration out, works. Claiming it records what exists invites the rot
> described in §2.2. Where the graph was populated by parsing real configs, mark those nodes as
> such and show their age."*

**The governing rule of this document, stated once, in caps, at the top:**

> **THE DIAGRAM IS A RENDERING. IF A FACT EXISTS ONLY IN THE PICTURE, THE PICTURE HAS BECOME THE
> DATA STRUCTURE AND §4.1 OF THE BRIEF HAS FAILED.**

Brief §4.1 says it directly: *"a line between two boxes does not say whether it is an L2 trunk, an
L3 point-to-point, an LACP member link or a tunnel. Build diagram-first and you will bolt
properties onto edges until you have an accidental, undocumented data model."* Every gesture in §6
therefore terminates in an **op against the graph**, never in a property on a shape. There is no
`shape.label`, no `edge.style`, no `node.color`. The only view-local state in the entire diagram is
the pan/zoom transform and the layer mask, and both are session state (`52` §10).

---

## 0. Contents

| § | |
|---|---|
| 1 | Scope — what this view is for, and the two things it must never claim |
| 2 | Rendering technology — SVG, Canvas, WebGL, decided |
| 3 | Layout — why automatic layout of network diagrams looks wrong, and the algorithm |
| 4 | The layer model, kind by kind |
| 5 | Visual language — the diagram's channel budget |
| 6 | Interaction — select, drag, connect, and the round trip to config |
| 7 | The Outline, and the bijection |
| 8 | Staleness without a fourth colour |
| 9 | Export — SVG, PNG, print, and the exfiltration problem |
| 10 | Performance |
| 11 | Failure modes |
| 12 | Open decisions |
| 13 | **PROPOSED (2026-08-08)** — zoom, containment, and the ladder of places |
| 14 | Sources consulted |
| 15 | Disagreements |

---

## 1. Scope

*margin tab: read this first*

### 1.1 The three jobs

| Job | What it means | What it is not |
|---|---|---|
| **Draw what you are about to build** | Place two firewalls, draw a tunnel, get the six named objects and the five plumbing pieces as a graph you can then complete and emit | A whiteboard. Every shape is a node with a kind and an ID |
| **See what you pasted** | `show configuration \| display set` in, picture out (brief §6.3) — the diagram is how a user confirms the parse understood the box | A discovery tool. Nothing is polled, nothing is probed (invariant 2) |
| **Navigate** | Click a node, the config view highlights its emit closure, the findings view filters to it (`52` §5) | The primary navigation. `Ctrl+K` and the inventory table are faster for anything you can name |

### 1.2 The two claims it must never make

**It is not a source of truth.** The brief is explicit and §2.2 of the brief explains why:
published analysis of source-of-truth deployments puts documentation accuracy at roughly 15–30%
without automated synchronisation. A diagram that claims to record the estate acquires that failure
mode on day one. So:

- Every node whose values came from a parse carries its age, and the diagram shows it (§8).
- Every node whose values were typed carries no age at all, because a human assertion does not
  decay (`11` §8.7) — it is either still true or it is wrong, and the tool has no basis to guess.
- **The view never says "current".** There is no refresh button, no sync indicator, no green dot.
  There is a date and a number of months.

**It is not complete.** At more than 2,000 live SVG elements it aggregates to `Site`/`Device` level
and requires a drill-down (`44` §4.7.4). An engineer who wants their 200-device estate on one
screen cannot have it, and the answer is the inventory table. `52` §3.6.1 already states that this
is a worse answer than the one they wanted and is the true one.

### 1.3 The scope this creates

| In scope | Out of scope |
|---|---|
| Devices, chassis, interfaces, units, addresses, VLANs, routing instances, static routes, zones, policy sets, NAT rule sets, tunnels, IPsec objects, external peers | Runtime state of any kind: SA indices, tunnel up/down, interface counters, learned routes. `11` §6.9 keeps these out of the graph, so they cannot reach the picture |
| Manual position, per node, workspace-persistent | Free-floating annotations, text boxes, arrows that are not edges, clip art, background images |
| Five layers, toggled independently | A sixth layer. See §4.7 |
| Export to SVG, PNG, print | Import from SVG or Visio. The graph is the source; the picture is a projection and projections do not invert |

---

## 2. Rendering technology

*margin tab: this is the one people argue about*

### 2.1 The forces

| # | Force | Source |
|---|---|---|
| R1 | 500 nodes at 60 fps during pan | `44` B13: 8 ms P95 pan frame, ≤ 1% dropped over a 5 s scripted pan |
| R2 | First render of 500 nodes in 160 ms P95 | `44` B12 |
| R3 | **The aesthetic is typographic.** Every label is an identifier — `reth0.0`, `st0.0`, `VPN-B`, `10.255.0.1/30` — set in mono, and the card's whole texture is mono-in-context | `design-language.md` |
| R4 | It must have an accessibility tree, or the Outline has to be built from something | `55` §4.5 |
| R5 | Export re-serialises from the same builder that draws the live tree | `34` §5.6 |
| R6 | No `<foreignObject>`, no `<image>`, no `<use>`, no `<style>`, no `href` | `34` §5.6 |
| R7 | Determinism: same workspace + same build ⇒ identical picture, byte-identical export | invariant 9 |
| R8 | It ships inside a 3.4 MB single HTML file with no runtime dependencies | `44` §5.3, `34` §8.2 |

### 2.2 The three candidates

| | **SVG** | **Canvas 2D** | **WebGL** |
|---|---|---|---|
| Text quality (R3) | Real font stack, real hinting, real subpixel positioning, identical to the rest of the sheet | `fillText` — no kerning control, no ligature control, and **not subpixel-consistent with the DOM text 20 px away** | SDF atlas. Good at large sizes, mushy at 12.5 px, and a whole subsystem to build |
| Accessibility (R4) | A DOM tree exists; even hidden, it is the thing the Outline is generated alongside | Nothing. A bitmap | Nothing |
| Export (R5) | The builder emits the export directly | A second serialiser | A third |
| Determinism (R7) | Text metrics come from the font; layout comes from the core | Same, plus canvas AA differences between engines | GPU rasterisation differs by driver — **R7 is unmeetable** |
| Hit testing | We do our own grid bucket anyway (`41` §4.5b), so SVG's built-in hit testing is unused | Must do our own | Must do our own |
| 500 nodes, first render | ~1,712 elements via `createElementNS` | One pass, fast | One pass, fastest |
| 500 nodes, pan frame | One `transform` on one `<g>` — **if** the engine composites it | Full redraw per frame | Trivial |
| Corporate laptop risk | none | none | GPU blocklists, driver resets, `webgl` disabled by policy. **A tool that fails to draw on a locked-down laptop is a tool that does not exist** |
| Bundle cost (R8) | zero | zero | a shader pipeline, an SDF generator, a text atlas |

**DECISION — SVG, built with `createElementNS` from `34` §5.6's closed tag set. WebGL is rejected
outright. Canvas is rejected as the renderer and retained as a drag-time optimisation only.**

### 2.3 Answering the performance argument honestly

The argument for Canvas is R1, and it is a real argument. Three reasons it loses anyway:

1. **The pan path does not touch elements.** `44` §4.7.1 already specifies it: exactly one attribute
   write per frame, `transform` on one `<g>`. The scene is static in scene coordinates; only the
   scene→screen mapping moves. This is the whole ballgame, and it is why SVG's element count does
   not cost anything *during* a pan.
   <!-- VERIFY: 44 §4.7.1 carries the measurement that decides this — whether current Chromium,
        Gecko and WebKit promote a transform on an SVG <g> to the compositor or re-rasterise the
        subtree every frame. It is the same VERIFY and it should be answered once, for both
        documents, with a 1,700-element scene under a scripted 5-second pan read from frame commit
        timestamps rather than rAF. -->
2. **The element count is capped by product design, not by the renderer.** `44` §4.7.4 caps live
   elements at 2,000 and aggregates above it, because *"a 5,000-node picture of a network is not a
   diagram, it is a texture, and nobody has ever found anything in one."* Canvas would let us draw
   50,000 elements at 60 fps and the result would be useless. **Choosing the renderer that makes
   the wrong thing easy is how a design tool becomes a texture generator.**
3. **Canvas costs a second implementation of everything else.** Export (R5), accessibility (R4) and
   hit testing all need a non-bitmap source of truth. With SVG that source is the DOM we already
   built. With Canvas it is a parallel scene graph that has to stay pixel-consistent with the
   rasteriser forever. `44` §4.7.3 prices this as *"a real and permanent maintenance obligation"*
   and that is the reason the canvas fallback is scoped to drag frames only.

**The retained fallback, unchanged from `44` §4.7.3:** if the VERIFY above comes back badly,
rasterise the scene once on `pointerdown`, translate the bitmap during the drag, restore the live
SVG on `pointerup`. Hit testing and focus rings are dead during the drag, which is acceptable
because you cannot click what you are dragging. It is a fallback because it is a second renderer,
and second renderers are how pixel-consistency bugs are born.

### 2.4 The consequence nobody expects: labels must be mono

R6 forbids `<foreignObject>`, so there is no HTML text layout inside the SVG. Every label's width
has to be computed by us, before layout, in the core, deterministically (R7), and identically in
the browser and in the CLI's headless export.

Measuring proportional text requires per-glyph advance tables. Measuring **monospaced** text is
arithmetic:

```
width_px = char_count × advance_em × font_px
DejaVu Sans Mono advance = 0.6021 em      (51 §7.3, measured from the binary)

--t-mono   12.5 px  →  7.526 px per character
--t-tab    11   px  →  6.623 px per character
--t-micro  10   px  →  6.021 px per character
```

> **DECISION — every label in the diagram is set in mono. There is no proportional text in the
> picture at all.**

This is not a compromise dressed as a decision. It is right for four independent reasons:

| | |
|---|---|
| **It is what the card does** | *"every command, every config line, every identifier, every field name in prose"* is mono. Every diagram label **is** an identifier: `reth0`, `st0.0`, `VPN-B`, `10.2.0.0/16`, `IKE-P1` |
| **It makes layout exact and deterministic** | Label widths are integer arithmetic on a 4 px grid. No font-metrics dependency, no `measureText`, no reflow after `fonts.ready`, and the CLI's export is byte-identical to the browser's |
| **It removes a font from the export** | §9.2 — an exported SVG needs one family, not two |
| **It caps what the picture can say** | A device `description` in prose does not fit and does not belong. The picture holds identifiers; the inspector holds prose |

**The cost, stated plainly:** long free-text names look worse in mono than they would in Liberation
Sans, and a site called `Manchester Distribution Centre` will be truncated to fit. Truncation is at
the *end*, with an ellipsis character, and the full text is in the Outline
row and in the inspector (the per-node `<title>` is deleted per M32 — it was hover-only and
inside an `aria-hidden` subtree, so it mitigated nothing for keyboard or screen-reader users). Names that are identifiers — which in this product is almost all of them
— are unaffected.

### 2.5 The element inventory at 500 nodes

`44` §4.7 sets the budget; this is what fills it.

| Element | Count | Note |
|---|---|---|
| node `<rect>` | 500 | 1 px stroke, `--page` fill |
| node label `<text>` | 500 | **the expensive one** — text layout, not fill, dominates SVG cost |
| node age line `<text>` | ≤ 500 | only at zoom > 0.6 and only for aged nodes (§8) |
| edge `<path>` | ~700 | mean degree ≈ 2.8 with interfaces collapsed into devices |
| edge label `<text>` | 0 below zoom 0.6 | level of detail, `44` §4.7.2 |
| band `<path>` (zones, routing instances) | ~12 | §4.4, §4.3 |
| focus ring `<rect>` | 1 | drawn by us, §6.2 |
| selection marks `<rect>` | ≤ 8 | |
| **live** | **≈ 1,712** | ceiling **2,000** (`svg_elements_live`, a gated counter) |

Above 2,000 the view aggregates (`44` §4.7.4). That is a product decision, restated here so nobody
"fixes" it with a faster renderer.

---

## 3. Layout

*margin tab: why it looks wrong*

### 3.1 Why automatic layout of network diagrams usually looks wrong

Four reasons, and only the first is about the algorithm.

**1. The engineer already has a canonical picture and the algorithm does not know it.** Network
diagrams are drawn to a convention that is decades old and almost never written down: the internet
at the top or the left edge, then the WAN edge, then firewalls, then core, then distribution, then
access, then hosts. The DMZ is off to one side. Redundant pairs are side by side, at the same
height, always. A layout that optimises edge-length uniformity produces a picture that is *correct*
and *unrecognisable*, and the reaction is not "this is a different arrangement", it is "this is
wrong".

**2. Force-directed layout is non-deterministic, and invariant 9 forbids that.** A spring embedder
seeded randomly gives a different picture every run; seeded deterministically it gives a picture
that changes completely when one node is added, because the energy minimum moved. Both are
disqualifying. The second is disqualifying even without invariant 9 — it is the **mental map**
problem, and it is the single most common complaint about automatic layout in any tool that has it.

**3. Network graphs have structure that force layout actively destroys.** A pair of core switches
with an MLAG between them and forty downstream links each is, to a spring embedder, two
high-degree nodes that should be pushed apart. To an engineer they are one thing and belong
adjacent. Bandwidth, redundancy and role are the real grouping keys and none of them is a graph
property.

**4. Nobody re-lays out a diagram they have already fixed.** Once a user has dragged four boxes to
where they want them, any automatic layout that moves those four boxes has cost them more than it
saved. So the *real* requirement is not "lay this out well", it is **"lay out the parts I have not
touched, and do not touch the parts I have."**

### 3.2 DECISION — layered, with semantic ranking, and manual positions as constraints

Sugiyama-style layered layout, with two departures from the textbook:

- **Layer assignment is semantic first, graph-theoretic second.** The rank comes from the node's
  role and kind; longest-path ranking is the fallback for anything unranked.
- **Pinned nodes are obstacles, not overrides.** A pinned node participates in every phase as a
  fixed point; the rest of the layout is computed around it.

Force-directed is rejected (reasons 2 and 3). Constraint-based layout — expressing the conventions
as separation constraints and solving — was considered seriously and rejected on cost: a QP or
gradient-projection solver is a large dependency or a large piece of work, it is a floating-point
solver (which is a determinism hazard across platforms), and the constraints an engineer actually
wants are almost all expressible as *layer assignment plus ordering within a layer*, which is what
Sugiyama already gives. **Constraint solving is the right answer to a problem we can avoid having.**

### 3.3 The algorithm, phase by phase

Input: the view graph — the projection of the graph under the active layer mask (§4). Output: a
packed `f32` coordinate array (X16 in `41` §3.2) plus the Outline rows (`55` §4.5.3).

| # | Phase | Method | Complexity | Determinism control |
|---|---|---|---|---|
| 1 | **Project** | Walk the graph, emit view nodes and view edges per §4's table | `O(V + E)` | Iteration in `NodeId` order — ULIDs sort lexicographically and are monotonic in time |
| 2 | **Rank (semantic)** | `rank = SEMANTIC_RANK[kind, role]`; unranked nodes get `rank = 1 + max(rank of predecessors)` by longest path | `O(V + E)` | Table lookup; the table is data |
| 3 | **Break cycles** | Greedy DFS: edges to an already-open node are reversed and flagged `reversed` so they can be drawn with their true direction | `O(V + E)` | DFS start order is `NodeId` order |
| 4 | **Insert dummies** | One dummy per crossed layer for every edge spanning more than one rank | `O(Σ span)` | — |
| 5 | **Reduce crossings** | Median heuristic, **fixed 8 sweeps** (4 down, 4 up), ties broken by `NodeId` | `O(sweeps · Σ_l n_l log n_l)` | **Fixed sweep count.** An adaptive termination criterion is a determinism bug, not an optimisation |
| 6 | **Assign x** | Brandes–Köpf: four extreme alignments, median of the four | `O(V + E)` | Integer arithmetic on the 4 px grid |
| 7 | **Apply pins** | Pinned nodes are placed first (phase 6 treats them as fixed); overlapping free nodes are pushed along the layer | `O(V log V)` | |
| 8 | **Route edges** | Orthogonal; each inter-layer band is a channel set, allocated by interval-graph greedy colouring | `O(E log E)` | Edges sorted by `(from rank, from x, EdgeId)` |
| 9 | **Bands** | Zone brackets and routing-instance boxes computed from placed members (§4.3, §4.4) | `O(V)` | |
| 10 | **Labels** | Placement by the four-candidate rule (§5.5); unplaced labels counted, not silently dropped | `O(L log L)` | |

**Cost at 500 nodes / 700 edges,** with ~400 dummies over 7 layers:

```
phase 5:  8 sweeps × 900 elements × log₂(129) ≈ 8 × 900 × 7  ≈  50,400 comparisons
phase 6:  4 passes × 1,300 elements                          ≈   5,200 visits
phase 8:  700 log 700                                        ≈   6,600
```

Layout is not the bottleneck. `44` B12's 160 ms budget is spent on `createElementNS` and text
layout, not on this. A layout that takes 10 ms and a DOM build that takes 120 ms is the expected
split, and it is why §2.3 argues about elements rather than about algorithms.

### 3.4 The semantic rank table

Data, not code — the same principle as rule packs.

```yaml
# fathom-layout/ranks.yaml. Lower rank is drawn higher on the page.
ranks:
  - { kind: ExternalPeer,                       rank: 0 }
  - { kind: Device, role: Router,   at_edge: true, rank: 1 }   # WAN edge
  - { kind: Device, role: Firewall,             rank: 2 }
  - { kind: Device, role: Router,               rank: 3 }
  - { kind: Device, role: Switch,   uplinks: 0, rank: 4 }      # core: no uplinks
  - { kind: Device, role: Switch,               rank: 5 }
  - { kind: Device, role: LoadBalancer,         rank: 5 }
  - { kind: Device, role: Other,                rank: null }   # longest path
fallback: longest_path
tie_break: node_id
```

`at_edge` and `uplinks` are computed predicates over the projected graph, not stored fields —
`at_edge` means "has an edge to an `ExternalPeer` or an interface with a public address",
`uplinks: 0` means "no edge to a lower-ranked device". They are heuristics and they are wrong
sometimes; being wrong sometimes is what a *starting* layout is for, and §3.5 is how the user fixes
it permanently.

**RECOMMENDATION, and it is `41` §4.5b's recommendation restated because it is the correct scoping
call:** build phases 1, 2, 7, 8 and a grid placement first. Ship a diagram that lays out plausibly
and lets you fix it by dragging. Phases 3–6 are a separately-scoped piece of work worth weeks, and
a diagram you can drag is worth more than a diagram that arranges itself well and does not exist.

### 3.5 Manual positions — how they are stored and how they survive

Positions are **graph data**, not view state. `52` §10 already places them in the workspace; `11`
§10.6 already guarantees they survive a rename because they are keyed by `NodeId`.

```rust
/// Attached to any node that can be drawn. Absent means "lay me out".
/// Provenance is Origin::Hand — a position is a human assertion, and 11 §8.7
/// deliberately does not age human assertions.
pub struct LayoutHint {
    pub pin: Pin,
    /// The layer mask in force when the user pinned it, recorded for the
    /// diagnostic in §3.7. Never used to select a position.
    pub pinned_under: LayerMask,
    pub at: Timestamp,
}

pub enum Pin {
    /// Default. The layout owns this node.
    Free,
    /// Absolute scene coordinates, on the 4 px grid. Layout works around it.
    At { x: i32, y: i32 },
    /// Weaker: keep it in this layer, order within the layer is the layout's.
    /// Produced by dragging a node vertically past a layer boundary.
    InLayer { rank: u16 },
    /// Weakest: keep these nodes adjacent and in this relative order.
    /// Produced by selecting several nodes and pressing `G`.
    Grouped { group: GroupId, ordinal: u16 },
}
```

**Three properties, each of which is the answer to a real complaint:**

| Complaint | Property |
|---|---|
| *"I moved it and the next re-layout moved it back"* | `Pin::At` is a constraint on every subsequent layout, not a one-off. Phase 7 places pins first |
| *"I moved one box and the whole picture rearranged"* | Phase 5 **seeds its initial ordering from the previous layout's ordering** rather than from scratch. A small graph change produces a small position change. This is the entire mental-map fix and it costs one array copy |
| *"My colleague moved my boxes"* | `52` §12 D5 has this open. The position is a class B last-write-wins field under `33` §6.4. **RECOMMENDATION — LWW, and if the complaint arrives, add a per-user layout overlay then, not now** |

**Unpinning is explicit and reversible.** `Shift+U` on a selection sets `Pin::Free` and re-runs
layout; `Ctrl+Z` restores the pins, because the pin change is an op like any other.

### 3.6 One scene, filtered — not five scenes

> **DECISION — layout is computed once, over the union of all layers, and a layer toggle filters
> what is drawn. Toggling a layer never moves anything.**

The alternative — one layout per layer combination — is 31 layouts, 31 sets of positions to store,
and a view where turning on the security layer rearranges the physical one. That is the behaviour
that makes people stop using layer toggles.

**The cost, stated honestly:** an L3-only view is laid out to accommodate physical nodes that are
not being drawn, so it looks sparse and slightly arbitrarily spaced. There will be gaps whose cause
is invisible. That is a real aesthetic cost and it buys a property worth much more: **the picture
is stable, so a user can build a mental map of it.**

**Two exceptions, both because they are derived from the visible set rather than positioned:**

- **Zone brackets and routing-instance boxes** are recomputed for the currently visible members
  (§4.3, §4.4). Their *members* never move; their outlines do.
- **Edge routing** is recomputed when a layer changes, because a hidden layer's edges free up
  channels. Endpoints never move.

### 3.7 The regroup command — the one thing that does move nodes

`Group by zone`, `Group by site`, `Group by routing instance`. Each re-runs layout with that
grouping as the primary constraint (phase 6 gains a separation constraint per group), which moves
free nodes and leaves pinned ones alone.

It is a **command**, invoked deliberately, with an undo — not a layer toggle. The distinction is
the whole point of §3.6: **toggles reveal, commands rearrange.** The view band says which grouping
is in force (`52` §9.3), because a grouping you forgot you applied is a picture you will misread.

---

## 4. The layer model

*margin tab: what each one draws*

Five layers, toggled independently (brief §6.5). A node or edge is drawn if it is in **any** active
layer. `LayerMask` is a 5-bit set; the 31 non-empty combinations are the fixture space for `55`
§4.5.8's bijection test.

### 4.1 The projection table

| Graph element (`11` §6–7) | physical | L2 | L3 | security | overlay |
|---|---|---|---|---|---|
| `Site` | band | band | band | band | band |
| `Device` | box, subdivided by `Chassis` | box | box | box | box |
| `Chassis` | **sub-row inside the device box** | — | — | — | — |
| `Interface` (physical port) | port stub on the device edge | — | — | — | — |
| `AggregateInterface` | **bracket** joining member ports | one interface stub | if it has units with addresses | — | — |
| `RethInterface` | **bracket spanning two chassis sub-rows** | one interface stub | if it has units with addresses | — | — |
| `TunnelInterface` (`st0`) | — | — | interface stub | — | endpoint of the conduit |
| `LogicalUnit` | — | stub, if `EthernetSwitching` | stub + address label | stub, if a `ZoneMember` | — |
| `Address` | — | — | label on the unit | — | — |
| `Vlan` | — | **band across the devices that carry it** | — | — | — |
| `RoutingInstance` | — | — | **box** containing its units | — | — |
| `StaticRoute` | — | — | arrow from the RI box to the next-hop unit | — | — |
| `RoutingProtocol` | — | — | **badge on the RI box**, one per instance: `ospf a0` · `bgp 65001` | — | — |
| `ProtocolAdjacency` | — | — | **line between the two units that peer**, labelled by protocol — see §4.8 | — | — |
| `Zone` | — | — | — | **bracket** around its member units | — |
| `PolicySet` | — | — | — | edge between two zone brackets | — |
| `SecurityPolicy` | — | — | — | count on the `PolicySet` edge | — |
| `NatRuleSet` | — | — | — | tick on the scoped unit or zone | — |
| `AddressObject`, `Application` | — | — | — | — | — (inspector only) |
| `Tunnel` | — | — | — | — | **conduit** |
| `IpsecVpn` | — | — | — | — | endpoint label on the conduit |
| `IkeGateway` | — | — | — | — | label on the endpoint: peer + version |
| `TrafficSelector` | — | — | — | — | label on the conduit midpoint |
| `ExternalPeer` | box, rank 0 | box | box | box | box |
| `Link` edge | **line** | line (collapsed through aggregates) | — | — | — |
| `VlanMember` edge | — | **line, with trunk/access marking** | — | — | — |
| `ZoneMember` edge | — | — | — | membership in the bracket, not a line | — |
| `ResolvesVia`, `SelectorCovers`, `NatOverlaps` (derived) | — | — | inferred arrow | inferred tick | inferred |

Derived edges (`11` §7.6) are drawn in `--muted` with a margin tab `inferred` in the view band, per
that document's own rule.

### 4.2 The reth, at two layers — the worked answer

This is the question brief §2.1 raises directly: *"a Juniper `reth` sits next to a LAG in interface
listings and is not aggregation at all."* The diagram has to make that visible without a legend
entry per kind.

**At the physical layer**, a `reth` is **not one thing**. It is two ports on two different chassis,
only one of which forwards:

```
  ┌─ SRX-A ────────────────────────────────────────────┐
  │  node0                                             │
  │    ge-0/0/0 ┐                                      │
  │             ├──── reth0 · RG1                      │      ← bracket, device end only
  │  node1      │                                      │
  │    ge-5/0/0 ┘                                      │
  └────────────────────────────────────────────────────┘
       │                    │
       │  (link)            │  (link)
       ▼                    ▼
    SW-A/1              SW-B/1
```

Three facts are visible and none of them needs a colour or an icon: the two member ports are in
**different chassis sub-rows**; the bracket is drawn at the **device end only**; the bracket's
label carries the redundancy group.

**A LAG at the physical layer** is drawn with the same bracket device and one difference that is
geometrically honest:

```
  ┌─ SW-CORE ─────────────┐              ┌─ SW-DIST ─────────────┐
  │    xe-0/0/0 ┐         │              │        ┌ xe-0/0/0     │
  │             ├ ae0 ────┼──────────────┼──── ae0┤              │
  │    xe-0/0/1 ┘         │              │        └ xe-0/0/1     │
  └───────────────────────┘              └───────────────────────┘
```

**Brackets at both ends** — because a LAG aggregates on both sides and all members forward. The
reth brackets on one end only, because the far side does not know it is a reth and because the two
members terminate on different chassis of the same device.

**At the L2 layer** the reth is **one interface**: one stub, one line, one label.

```
  ┌─ SRX-A ─┐                      ┌─ SW-A ─┐
  │  reth0.0├──────────────────────┤ ge-0/0/1
  └─────────┘   vlan 10, 20, 30    └────────┘
```

The chassis sub-rows do not exist at L2, the member ports do not exist at L2, and the redundancy
group is a label in the inspector. **That is the point of layering: the same graph element renders
as two ports or as one interface depending on which question you are asking, and the tool never has
to decide which is "the truth".**

A LAG at L2 is drawn identically to the reth at L2 — one interface, one line. Which is correct:
at L2 they *are* the same thing, and pretending otherwise would be inventing a difference the
network does not have.

### 4.3 Routing instances — a partition, drawn as a box

A `RoutingInstance` contains `LogicalUnit`s via `InRoutingInstance`. Units in one instance are
almost always adjacent in a layered layout (they hang off the same devices), so a box works:

- **1 px `--ink` rectangle** around the bounding box of the member units, inset `--s2` (8 px).
- Label in the **top-left corner, inset `--s1`**, uppercase tracked `--track-head`, `--t-micro`.
- The default instance (`inet.0`) is modelled explicitly (`11` §6.5) and is **not drawn** — a box
  around everything is a box around nothing.
- Nested boxes are legal (an `L3Vpn` instance inside a site band) and nest by inset.

Not `--hairline`: `55` §2.5 F1 forbids a 1.45:1 stroke from bounding a meaningful graphic.

### 4.4 Zones — a set, not a place

**The hard one.** A `Zone` is a set of `LogicalUnit`s (`ZoneMember`, out `0..n`, in `0..1`). A unit
is in at most one zone, so zones *partition* the units they cover — but they have no location, and
their members can be anywhere the layout put them.

Four options and why three lose:

| Option | Why not |
|---|---|
| Coloured wash per zone | There is no fourth colour and there is no fifth or sixth. `51` R1 |
| Convex hull around members | Hulls of interleaved sets overlap, and an overlap between two zones is a visual claim that is false — a unit is in exactly one zone |
| Force zone members adjacent by re-running layout | That is §3.7's regroup **command**. Making it a *layer toggle* means turning on the security layer rearranges the picture, which §3.6 forbids |
| **Bracket the members, and show discontiguity rather than hiding it** | Chosen |

**The bracket.** A zone is drawn as a mathematical bracket — two vertical 1 px `--ink` strokes with
`--s2` horizontal returns at top and bottom — around the bounding box of its visible members, inset
`--s3`. The label sits at the top of the left stroke, uppercase, tracked, `--t-micro`. **Stroke
only, never a fill**, so it survives `forced-colors` (`55` §7.3).

**Three tiers of degradation, with the condition for each:**

| Tier | Condition | Drawing |
|---|---|---|
| **1 — contiguous** | The zone's members occupy a contiguous run within their layers and the bracket intersects no other zone's bracket | One bracket, label `WAN` |
| **2 — clustered** | Members fall into `k ≤ 3` clusters (agglomerative on the 4 px grid, threshold = 2 × layer pitch) and the `k` brackets do not intersect another zone's | `k` brackets, each labelled `WAN 1/3`, `WAN 2/3`, `WAN 3/3` |
| **3 — scattered** | `k > 3`, or any bracket would intersect another zone's bracket | **No bracket.** Each member unit gets a 4 px stub on its left edge with the zone name in `--t-micro`, and the view band reads `security · 4 zones, 2 shown as ticks` |

Tier 3 is not a failure state that has been hidden; it is the honest rendering of a network whose
zone membership does not follow its physical shape — which is common and is itself worth seeing.
The affordance is `Group by zone` (§3.7), and the view band says so: `⌥Z to group by zone`.

**Zone-pair policy.** A `PolicySet` with `scope: ZonePair{from, to}` is drawn as a single edge
between the two brackets, with an open-V arrowhead at the `to` end and a label giving the policy
count and the default action:

```
   ┌ TRUST                    ┌ VPN
   │  …units…      ───────▶   │  st0.0
   └                 4 · deny └
```

`4 · deny` is four policies in the set, default action deny. Clicking the edge opens the ordered
policy list in the inspector — which is the right place for an ordered list of 400 rules, and the
diagram never tries to draw one.

**Under tier 3** there is no bracket to connect, so the policy-set edge is drawn between the
**device boxes** that own the zones, with the label carrying both zone names:
`TRUST → VPN · 4 · deny`. Degrading the anchor rather than dropping the edge is deliberate: the
zone pair is the most valuable fact on the security layer.

### 4.5 VLANs — the other set

A `Vlan` is also a set (of `LogicalUnit`s via `VlanMember`) and gets the same treatment with one
difference: VLANs are usually *horizontal* — the same VLAN spans many devices at the same layer —
so the VLAN band is drawn as a **horizontal bracket** (two horizontal strokes with vertical
returns) rather than a vertical one. Orientation is the only difference, and it is enough to tell a
VLAN band from a zone bracket at a glance without a legend.

Above 6 visible VLANs the bands are suppressed and VLAN membership moves entirely onto the edge
labels (`vlan 10, 20, 30`), with the view band reading `L2 · 14 vlans, bands off`. Six overlapping
bands is a texture.

### 4.6 The overlay layer — tunnels

A `Tunnel` is drawn as a **conduit**: two parallel 1 px `--ink` rails, 5 px apart, with the ends
closed by a 1 px cap. A closed-end conduit reads as one object, and the metaphor is exact — a
tunnel is a pipe carrying another pipe.

```
    SRX-A                                                    SRX-B
  ┌────────┐  ╔══════════════════════════════════════════╗ ┌────────┐
  │ st0.0  ├──╢  10.1.0.0/16 ↔ 10.2.0.0/16               ╟─┤ st0.0  │
  └────────┘  ╚══════════════════════════════════════════╝ └────────┘
   10.255.0.1/30                                    10.255.0.2/30
   VPN-B · GW-B → 203.0.113.10 · v2-only     VPN-A · GW-A → 198.51.100.5 · v2-only
```

Labels, in order of survival as zoom drops:

| Zoom | Shown |
|---|---|
| > 0.6 | Everything above: endpoint `st0` units, overlay addresses, `IpsecVpn` name, gateway peer and IKE version, and the traffic selector at the midpoint |
| 0.35 – 0.6 | The conduit and the two device names only |
| < 0.35 | The conduit only |

**One-sided tunnels** — the normal case, per `11` §6.7 — draw the conduit from the modelled
`IpsecVpn` to an `ExternalPeer` box, and the peer box is a **half-height box with an open right
edge**. The open edge is the drawing of "we do not model what is over there", and it is worth more
than a cloud glyph would be, because it is unambiguous and it is not an icon.

**Policy-based VPNs** (side 1's legacy mode) have no `st0` at all. The conduit runs from the
`SecurityPolicy` that carries `TunnelsVia`, and its endpoint cap is drawn against the zone bracket
rather than a unit. The view's own margin tab says `policy-based · legacy`, which is the card's
verdict: *"Legacy — use route-based for anything new."*

### 4.7 Why there is no sixth layer

Candidates that have been proposed and refused, with the reason:

| Proposed layer | Refusal |
|---|---|
| "Provenance" / "freshness" | It is not a set of elements, it is an attribute of every element. §8 renders it on an unallocated channel instead |
| "Findings" | Findings attach to nodes across all five layers. `52` §5 already highlights the selection's findings in place |
| "AI proposals" | `51` §9's dashed rule already marks proposed elements wherever they appear. A layer would let a user hide the fact that something is proposed, which is the opposite of what that treatment is for |
| "Traffic" / "utilisation" | Invariant 2. We never touch a device, so we have no traffic data and never will |

**The rule that generalises:** a layer is a *set of graph elements*. An attribute of elements is a
treatment, not a layer.

### 4.8 OSPF and BGP — routing protocols on the L3 layer

**Added 2026-08-11, at the owner's request** (*"can you add ospf and BGP to the drawing layers
somehow? is that a reasonable ask?"*). It was reasonable, and the answer was mostly already here:
`schema/schema.yaml` declares `RoutingProtocol` (a `{ ospf, ospf_v3, bgp, isis, rip, ldp }` enum,
`router_id`, `local_as`, `areas`, `reference_bandwidth`) and `ProtocolAdjacency` (`peer_address`,
`peer_as`, `area`, `cost`, `network_type`, `import_policy`, `export_policy`,
`route_reflector_client`, `passive`). **What was missing was this document.** §4.1 calls itself the
layer model *kind by kind* and had no row for either — so the two kinds that carry every routing
protocol in the schema were absent from the table the diagram will be built from. That is a hole in
the spec, not a decision, and it is filled above.

**They belong to L3 and to no other layer.** A routing adjacency is not a cable and not a tunnel: it
is an agreement between two L3 addresses about which routes to believe. On the physical layer it
does not exist; on the overlay layer it would compete with the conduit for the same visual channel
and mean something different.

**`RoutingProtocol` is a badge, not a box.** A protocol instance has no position of its own — it is
a property of the `RoutingInstance` that owns it. Drawing it as a box would put an object on the
canvas that an engineer cannot point at on a rack, and would double the node count of a
default-instance-only estate for nothing. The badge carries the protocol and its one identifying
number: the area for OSPF, the AS for BGP.

**`ProtocolAdjacency` is a line between units, and its two ends are found differently by protocol.**
This is the substantive modelling point and it is why one row could not have covered both:

| | OSPF | BGP |
|---|---|---|
| What the adjacency is between | Two interfaces on a shared segment | Two addresses, which may be many hops apart |
| How the far end is found | `area` plus the segment — the `Link` edge already drawn at the physical layer | `peer_address`, resolved against every `Address` in the estate |
| When the far end is not in the estate | The neighbour is off-estate; draw to an `ExternalPeer` | The same, and much commoner: an upstream's `peer_as` is normally somebody else's router |
| What the line follows | The physical path, so it may be drawn **along** the `Link` | Nothing physical; it is a logical line and must be drawn as one |

So a BGP session to a transit provider is a line to an `ExternalPeer` box at rank 0, and an OSPF
adjacency across a LAN is a line that shadows a cable. Both are `ProtocolAdjacency`; only the
resolution differs.

**Incomplete adjacencies are drawn and marked, never hidden** — `70` §16.1's rule, and this is
exactly the case it was written for. A `peer_address` that resolves to no `Address` in the estate is
still an adjacency the operator configured; it is drawn `dotted` (`51` §9, and never `dashed`, which
is reserved for proposed elements) to the edge of the canvas with the peer address as its label.
Refusing to draw it would hide the most interesting thing on the diagram: the session whose other
end you have not captured yet.

**What is not built.** Nothing above is code. The diagram view does not exist, and neither does any
dictionary entry that would produce a `RoutingProtocol` from a pasted config — the junos-srx
dictionary has 42 entries and not one is under `protocols` or `routing-options` except the static
route. So an estate today contains no routing protocols at all, from any door. Making the two kinds
visible in the inventory is the cheap half and is done; parsing them and drawing them are two
separate later pieces of work, in that order.

---

## 5. Visual language

*margin tab: no icons, no colour*

### 5.1 The constraint

`design-language.md`, *What the card never does*: **no logos, no pictorial icons, no
illustrations, no rounded corners, no drop shadows, no gradients** — restated per M31: the
product does use a small closed set of typographic glyphs (`▸`, `▲`, `▴`/`▾`, `↳`, ticks and
brackets drawn as geometry), enumerated in `54` §22, and the absolute "no icons" wording was
falsified by them. And `51` R1: the three risk colours are reserved
for what a *command* does to a live box, which is a property of emitted config lines and has no
meaning on a topology node.

**So the diagram has no colour at all.** Not "colour used sparingly" — none. Everything below is
drawn in `--ink`, `--muted` and `--page`, at 1 px and 2 px, in geometry.

### 5.2 The diagram's channel budget

The same exercise `51` §4.1 does for the sheet, done for the picture. **This table is the contract:
one channel, one meaning, and nothing may be added to it without taking something away.**

| # | Channel | Values | Meaning | Reserved by |
|---|---|---|---|---|
| G1 | Node boundary **tone** | `--ink` / `--muted` | Freshness: Fresh+Ageing / Stale+Unverified. **Light theme only (M39):** `--ink` vs `--muted` is 2.381:1 in dark, so §8.1 forces the age label on at every zoom there — the dark diagram has nine channels, not ten | §8 |
| G2 | Node boundary **dash** | solid / dashed | Deterministic / AI-proposed | `51` §9, product-wide. **Unavailable to this document** |
| G3 | Node boundary **weight** | 1 px / 2 px | Unselected / selected | §6.1 |
| G4 | Edge **rail count** | 1 / 2 separate / 2 capped | Simple link / aggregate-or-reth members / tunnel conduit | §4.2, §4.6 |
| G5 | Edge **terminal** | port stub / bracket both ends / bracket one end | Plain link / LAG / reth | §4.2 |
| G6 | Edge **mid-tick** | none / one tick / two ticks | Untagged / access / trunk | §5.4 |
| G7 | Band **form** | vertical bracket / horizontal bracket / closed box | Zone / VLAN / routing instance | §4.3–4.5 |
| G8 | Node **second label line** | absent / present | Age in words | §8 |
| G9 | **Arrowhead** | none / open V | Undirected / directed (routes, policy direction) | §5.3 |
| G10 | **Margin tab in the view band** | free text | Counts, hidden labels, layer and grouping state | `52` §9.3 |

Two things this table makes visible:

- **G2 is spent before this document starts.** Dashed means AI-proposed and dotted means pending,
  product-wide, and a diagram that used a dash for "tunnel" or "logical link" would break the one
  treatment that tells a user which parts of the screen a model wrote. That is why the tunnel is a
  conduit and not a dashed line — §4.6's decision is forced by `51` §9, and it turned out better
  than the dash would have been.
- **G10 is the release valve, exactly as `51` §4.1's C10 is.** Anything the picture cannot say, the
  view band says in three lowercase words. `diagram · 12 nodes · L3`, `4 labels hidden`,
  `3 nodes unverified`, `grouped by zone`.

### 5.3 Strokes, weights and the zoom problem

```css
--dg-stroke:        1px;   /* everything */
--dg-stroke-sel:    2px;   /* selection, G3 */
--dg-focus:         2px;   /* the focus ring, 55 §5.2 */
--dg-rail-gap:      3px;   /* between LAG/reth member rails */
--dg-conduit-gap:   5px;   /* between tunnel rails */
--dg-grid:          4px;   /* --s1. Every coordinate is a multiple */
```

Every stroke carries `vector-effect="non-scaling-stroke"`, which is a presentation attribute and
must be added to `34` §5.6's permitted attribute list. Without it a hairline at zoom 3 is a 3 px
slab and the whole idiom collapses.

**Text does not get a compensating transform.** Labels scale with the zoom, which is why level of
detail (`44` §4.7.2) exists: below zoom 0.6 the edge labels are unreadable, so they are not drawn
at all, and below 0.35 the node labels go too. **Drawing text nobody can read is how a diagram
becomes a texture**, and the LOD thresholds are the product's answer to that, not a rendering
optimisation.

### 5.4 The edge vocabulary, complete

| Concept | Drawing | Label |
|---|---|---|
| Physical `Link` | one 1 px `--ink` line, orthogonal, port stubs at both ends | port names at both ends, zoom > 0.6 |
| LAG member set | two lines, `--dg-rail-gap` apart, bracket at **both** ends | `ae0 · 2 members` |
| reth member set | two lines, `--dg-rail-gap` apart, bracket at the **device end only**, member ports in separate chassis sub-rows | `reth0 · RG1` |
| L2 access port | one line, **no tick** | `vlan 10` |
| L2 trunk | one line with **two 6 px cross-ticks** at the midpoint, `--dg-rail-gap` apart | `vlan 10, 20, 30` or `vlan 10–40 (14)` above 6 VLANs |
| L2 native VLAN on a trunk | as trunk, native VLAN first in the list and underlined | `vlan **1**, 10, 20` |
| L3 point-to-point | one line | address at each end |
| Static route | one line with an **open-V arrowhead** at the next hop, from the routing-instance box to the next-hop unit | `10.2.0.0/16` |
| Inferred edge (`11` §7.6) | one line in `--muted` | the derivation, plus a view-band tab `inferred` |
| Tunnel | **conduit**: two rails `--dg-conduit-gap` apart, capped at both ends | §4.6 |
| Zone-pair policy set | one line between brackets, open-V arrowhead at `to` | `4 · deny` |
| AI-proposed anything | the same drawing with `stroke-dasharray` | plus `51` §4.2's hatched gutter on the inspector panel |

**Arrowheads are drawn as two line segments in the same `<path>`**, not with `<marker>` — `marker`
is not in `34` §5.6's closed tag set and there is no reason to widen the set for it. The arrowhead
is 6 px long at 30° and it is drawn in scene coordinates, so it scales; at zoom < 0.35 arrowheads
are dropped with the rest of the detail.

### 5.5 Labels and label placement

| Label | Token | Case |
|---|---|---|
| Node primary (`SRX-A`, `reth0.0`) | `--t-mono` 12.5 px | as stored |
| Node second line (age) | `--t-micro` 10 px, `--muted` | lowercase, unpunctuated — the margin-tab register |
| Edge label | `--t-tab` 11 px | as stored |
| Band label (zone, VLAN, routing instance) | `--t-micro` 10 px, uppercase, `--track-head` — **and the label carries the kind** (M38): `WAN` reads `zone WAN`, a VLAN band reads `vlan 10`, an instance box reads `ri CUST-A`. The kind prefix is lowercase, in the margin-tab register. Ten geometric forms with no legend is answered the card's way — with a word, never a legend of shapes | uppercase (kind prefix lowercase) |
| Port stub | `--t-micro` 10 px | as stored |

**Placement:** each label has an anchor and four candidate positions, tried in a fixed order — E,
W, N, S of the anchor, at `--s2` offset. A candidate is accepted if its computed box (exact
arithmetic, §2.4) intersects no already-placed label and no node rect. Greedy, in
`(rank, x, ElementId)` order, so it is deterministic.

**Labels that cannot be placed are not drawn, and are counted.** The count goes in the view band:
`4 labels hidden`. Clicking it lists them in the inspector. A diagram tool that silently drops
labels is a diagram tool that lies about what it drew; a diagram tool that overlaps them is
unreadable. Counting is the only honest option.

Complexity: `O(L log L)` with a uniform-grid occupancy index over the same buckets §6.5 uses for
hit testing.

### 5.6 Node geometry, computed

```
node_width  = 2 × --s3  +  max(label_chars) × 7.526 px        →  ceil to 4 px
node_height = --lh-step  +  2 × --s2                          =  36 px
              + --lh-micro                                    =  52 px with an age line
layer_pitch = 96 px      (36 px of nodes + 60 px of routing channel = 15 × 4 px channels)
column_gap  = --s6       (32 px)
```

Worked: `SRX-A` is 5 characters → `24 + 37.6 = 61.6` → **64 px wide**.
`SRX-345-DC-EAST` is 15 characters → `24 + 112.9 = 136.9` → **140 px wide**.

At 36 px tall and ≥ 64 px wide, **every node exceeds the 24 × 24 CSS px target-size minimum at
zoom 1**, which is one of the two reasons `55` §6.5 can point at the node itself as the target. The
other reason is that below zoom 1 it cannot, and the Outline row is the Equivalent target.

### 5.7 A drawn element, as it is actually emitted

> **Amended — M33 (ADR-0026 (3)) and M32, ADR-0025 group.** Two changes to what follows.
> **(1) The live tree is drawn with `class` only** — colour resolves in the stylesheet from
> tokens, never as literal hex presentation attributes. As previously specified the diagram
> emitted `fill="#FFFFFF"`, `stroke="#5C6772"`, `fill="#14171A"` literally, exempt from `51`
> §3.3's `tokens/no-raw-hex` by a loophole: in dark mode the product drew white boxes with
> near-black text on a `#0F1215` page — 20% of the surface fighting the theme. The **export**
> serialises by resolving each class against the **light** token set explicitly (the export
> must freeze concrete values, `34` §5.6 forbids `<style>`), and the export header states
> that exports are light-only. One function, and it also satisfies `55` §7.3's forced-colours
> rules, which assume class-based styling. **(2) The per-node `<title>` is deleted** — it was
> a hover tooltip on up to 500 elements inside a subtree `55` §4.8 marks `aria-hidden`, i.e.
> mouse-hover-only, the precise failure `55` §1.4 lists as impossible. §2.4's real
> truncation mitigations (Outline row, inspector, digest) are sufficient; node provenance
> goes in the inspector. The root-level `<title>` of the export (§9) is unaffected.

One node and one edge. Live tree: `class` only. Export: the same tree with each class resolved
to the light token set as presentation attributes, closed tag set, no `style`, no `href`.

```xml
<!-- live tree -->
<g class="dg-node dg-stale" data-id="fathom:device:01JZQ8…">
  <rect class="dg-box" x="320" y="192" width="140" height="52"
        vector-effect="non-scaling-stroke"/>
  <text class="dg-label" x="332" y="212">SRX-345-DC-EAST</text>
  <text class="dg-age" x="332" y="228">parsed 11 months ago</text>
</g>

<path class="dg-edge dg-conduit" d="M460 218 L612 218 M460 223 L612 223
                                    M460 218 L460 223 M612 218 L612 223"
      fill="none" vector-effect="non-scaling-stroke"/>
```

Note the stale node's stroke resolves to `--muted`, not `--ink` — this node is 11 months old
(§8). Note the conduit is one `<path>` with four subpaths: two rails and two caps. **Every
edge is exactly one `<path>` element**, however many strokes it appears to have, which is what
keeps the element count in §2.5 honest.

---

## 6. Interaction

*margin tab: the round trip*

### 6.1 Selection

`52` §5 owns the selection model; this is its diagram binding.

| Gesture | Result |
|---|---|
| Click a node | `Facet::Element` on that `NodeId`. 2 px `--ink` stroke on the shape (G3), label in `--ink` |
| Click an edge | `Facet::Element` on that `EdgeId` |
| Click an edge **label** | `Facet::Field` — a decoration selects the field it renders. `52` §5 already specifies this: the `st0.0` label on a tunnel selects `LogicalUnit.name` |
| `Ctrl`/`⌘` + click | Toggle into the selection |
| `Shift` + click | **Refused.** `52` §5 states that range select is undefined across views and is refused rather than approximated. There is no meaningful "range" between two nodes in a graph |
| Marquee drag | Union of nodes whose bounding box intersects the marquee (`52` §5) |
| Click empty canvas | Clear |

**Closure highlighting.** Selecting `IpsecVpn VPN-B` highlights the selection at 2 px and its
closure at 1 px, with everything else at 40% opacity in the same ink (`52` §5). In the diagram the
closure of a `VPN-B` selection is: the conduit, both `st0` units, both gateways' external
interfaces, and the traffic selector label. Five elements out of 1,712, and the 40%-opacity
treatment is what makes them findable.

**Selection is never a coloured bar and never a fill.** `51` §4.6's argument holds here: ground
alone collides with hover, and a fill in the diagram would collide with nothing at all because
there are no fills — which is precisely why weight is the free channel.

### 6.2 Focus

Focus never enters the `<svg>` (`55` §4.5.2). The Outline holds it; the picture mirrors it:

```ts
// One element, reused, appended last so it paints over everything.
focusRing.setAttribute('x', String(box.x - 4));       // --s1 offset
focusRing.setAttribute('y', String(box.y - 4));
focusRing.setAttribute('width',  String(box.w + 8));
focusRing.setAttribute('height', String(box.h + 8));
focusRing.setAttribute('stroke-width', '2');
focusRing.setAttribute('vector-effect', 'non-scaling-stroke');   // stays 2 CSS px
```

`vector-effect` is what makes 2.4.13 Focus Appearance provable at every zoom: the ring is 2 CSS px
whether the scene is at 0.3× or 4×, so the "2 CSS pixel thick perimeter" test holds without a
zoom-dependent special case.

If the focused element is outside the viewport, the scene pans to it — instantly, no easing (§7 of
`51`), with the element placed at 25% from the leading edge rather than centred, so its neighbours
are visible.

### 6.3 Drag

| | |
|---|---|
| Pointer | `setPointerCapture` on `pointerdown`; one delegated listener on the `<svg>` |
| Snap | Every coordinate to `--dg-grid` (4 px) |
| Feedback | The node moves. Its edges are **not** re-routed during the drag — they follow their endpoints as straight segments and re-route on `pointerup`. Re-routing 700 orthogonal paths per frame is not a frame budget, it is a slideshow |
| Commit | On `pointerup`: one `Op::SetLayoutHint { node, pin: Pin::At { x, y } }` per moved node, in one op batch, one undo step |
| Multi-select | All selected nodes move together, preserving relative offsets (`52` §5) |
| Keyboard equivalent | Arrow = 4 px, `Shift`+arrow = 32 px, `Enter` commits, `Esc` reverts. **This is the reference implementation** and the drag is sugar for it (`55` §5.5) |
| Escape hatch | `Esc` mid-drag reverts to the pre-drag positions and releases capture |

**Layout is not re-run on drag.** `41` §3.2 budgets X15 at ≤ 5 calls per second — view change and
**drag end**, never drag frame.

### 6.4 Connect — the round trip

*margin tab: this is the feature*

This is where the diagram stops being a picture. The gesture is two-step by construction (§5.5 of
`55`): **select a source, press `L` (link) or `T` (tunnel), select a target, confirm.** Dragging
from a port to a port is a shortcut for the same three ops.

#### 6.4.1 Drawing a physical link

A `Link` edge is `Interface → Interface` (`11` §7.3), and a device-level gesture does not name
ports. So the gesture does not create an edge — **it opens an inline disclosure that resolves the
ports, and the edge is created on confirm:**

```
CONNECT   SRX-A  →  SW-A
  from    ge-0/0/2   ge-0/0/3   ge-0/0/4   + new interface
  to      ge-0/0/1   ge-0/0/2   + new interface
  media   copper     fibre      dac
                                                    [ connect ]   Esc cancels
```

Only *unlinked* interfaces are offered (`Cabled` is `0..1` on both ends). `+ new interface`
creates one, and the name is validated against the platform's interface-name grammar and the
device's `Chassis.slots` — which is the sort of check that only exists because interfaces are
typed nodes rather than strings on an edge.

On confirm: one `Op::AddEdge { kind: Link, from, to }` with `media`, provenance `Origin::Hand`.
That is it — one edge, one undo step, and the picture redraws.

#### 6.4.2 Drawing a tunnel — where a line becomes 60 lines of config

Selecting `SRX-A`, pressing `T`, selecting `SRX-B`, and confirming produces **the entire object
chain from side 1 of the field card**, on both sides, as real nodes with real holes.

The op batch, per side (side A shown; side B is the mirror):

```
AddNode  IkeProposal     IKE-P1
AddNode  IkePolicy       IKE-POL
AddNode  IkeGateway      GW-B
AddNode  IpsecProposal   IPSEC-P2
AddNode  IpsecPolicy     IPSEC-POL
AddNode  IpsecVpn        VPN-B          mode = RouteBased
AddNode  TrafficSelector TS1
AddNode  TunnelInterface st0
AddNode  LogicalUnit     st0 unit 0     families = {Inet}
AddNode  Address         10.255.0.1/30
AddNode  StaticRoute     10.2.0.0/16 → st0.0
AddNode  SecurityPolicy  TO-B           in PolicySet {TRUST → VPN}
AddEdge  UsesProposal     IKE-POL   → IKE-P1
AddEdge  UsesIkePolicy    GW-B      → IKE-POL
AddEdge  ExternalInterface GW-B     → reth0.0        ← resolved by the disclosure
AddEdge  UsesProposal     IPSEC-POL → IPSEC-P2
AddEdge  UsesIkeGateway   VPN-B     → GW-B
AddEdge  UsesIpsecPolicy  VPN-B     → IPSEC-POL
AddEdge  BindsInterface   VPN-B     → st0.0
AddEdge  HasTrafficSelector VPN-B   → TS1
AddEdge  ZoneMember       VPN       → st0.0
AddNode  Tunnel          SITE-A ↔ SITE-B
AddEdge  TunnelEndpoint  Tunnel → VPN-B  (side A)
AddEdge  TunnelEndpoint  Tunnel → VPN-A  (side B)
```

Twenty-five nodes and eighteen edges from one gesture. **Almost every field is
`Presence::Unknown`,** and that is the design, not a shortcoming:

| What the disclosure asks for | Why it must be asked here |
|---|---|
| Which unit is the **external interface** on each side | It is a required edge (`11` §6.7), and side 1 is emphatic: *"`external-interface` is the WAN unit the IKE packets leave by, not `st0`. Wrong on a multi-homed box means Phase 1 sources from an address the peer has never heard of"* |
| The **overlay prefix** for `st0` | `10.255.0.0/30`, split across the two ends |
| The **traffic selectors** | `10.1.0.0/16 ↔ 10.2.0.0/16` |
| Which **zone** `st0.0` joins | Plumbing piece #2 |

Four questions. Everything else — proposals, PFS, lifetimes, DPD, `establish-tunnels` — is left
`Unknown` and the findings panel immediately fills with the emitter's blockers and the rule pack's
findings, naming exactly what is missing:

```
BLOCKERS                                                          from emit
  IkeProposal IKE-P1     dh-group is unknown
  IkeProposal IKE-P1     encryption-algorithm is unknown
  IpsecProposal IPSEC-P2 protocol is unknown
FINDINGS
  high   zone.host-inbound.ike-missing   WAN/reth0.0 does not permit ike
  high   ipsec.pfs.absent                IPSEC-POL has no perfect-forward-secrecy
```

**That is the round trip working.** A line drawn between two boxes has produced a graph that
already knows what side 1 of the field card knows: which six objects exist, which five plumbing
pieces are needed, and which of them is missing. The `zone.host-inbound.ike-missing` finding fires
because `ZoneMember` is an edge with fields (`11` §7.5) — the diagram created the zone membership
and the rule read it, with no code between them.

**The honest cost:** the diagram is a bad place to answer twenty crypto questions. So the
disclosure's last row is a handoff:

```
  25 nodes created · 3 blockers · 2 findings          [ open walkthrough: site-to-site IPsec ]
```

The walkthrough (`52` §6) opens with both endpoints pre-filled and asks the rest in an interface
built for asking. **The diagram captures intent; the walkthrough completes it; the config view
emits it.** Three views, one graph, and the diagram does the part it is good at.

#### 6.4.3 What the connect gesture must never do

| Never | Because |
|---|---|
| Invent a proposal, a DH group, a lifetime or an algorithm | It would be `Presence::Set` with provenance `Origin::Hand` and a value nobody chose. `11` §8.5: only a parser over a closed-world capture, or a human explicitly asserting absence, may write `Absent` — and nothing at all may write a value the user did not supply |
| Accept a pre-shared key | Invariant 3 |
| Emit before the blockers are cleared | `13` §—'s blocker mechanism exists for this |
| Silently create a second `IpsecVpn` on an `st0` unit that already has one | `BindsInterface` is `in: 0..1` and it is a validity error. The disclosure refuses and says which VPN holds it |

### 6.5 Hit testing

Not `document.elementFromPoint`, and not one listener per element (`41` §4.5b). A uniform grid over
scene coordinates:

```
cell = 2 × median node width        (typically 256 px)
buckets: Map<cellIndex, ElementId[]>   built at layout, rebuilt on structural change only

query(px, py):
  1. screen → scene via the inverse of the one transform
  2. cell = (⌊x/cell⌋, ⌊y/cell⌋); gather that cell and its 8 neighbours
  3. test candidates in reverse paint order; nodes before edges
  4. edges: point-to-segment distance ≤ 4 px (--s1) against each subpath
```

`O(1 + k)` where `k` is the occupancy of nine cells — typically under 12 at any realistic density.
One delegated `pointerdown`/`pointermove` listener on the `<svg>`, and no listener per element,
which is also why the element count in §2.5 does not carry an event-handler cost.

### 6.6 Undo

Every gesture terminates in an op batch, and op batches are the undo unit (`17` §—). A drag of six
nodes is one batch of six `SetLayoutHint` ops and one `Ctrl+Z`. A tunnel connect is one batch of
forty-three ops and one `Ctrl+Z` — because half a tunnel is not a state the graph should be able to
be in.

---

## 7. The Outline, and the bijection

`55` §4.5 specifies the Outline in full and this document implements it. Two obligations live here:

**1. The Outline is produced by the layout call, not by a separate walk.** Phase 1 of §3.3 emits
`OutlineRow` alongside the view-node list. One traversal, one ordering, one source. A second walk
would drift.

**2. Every drawn element has exactly one row, and CI asserts it over all 31 layer masks**
(`55` §4.5.8). The practical consequence for anyone extending this view:

> **A new decoration is not shippable until it has an Outline row.** If a fact cannot be expressed
> as a row with a `spoken` sentence and a set of `links`, it probably should not be in the picture
> either — because a fact that can only be seen and not said is a fact the export, the digest, the
> CLI and the ticket will all lose.

That is a design filter as much as an accessibility one, and it has already changed one decision in
this document: the zone tier-3 fallback (§4.4) exists partly because a bracket that cannot be drawn
still has to produce the same Outline row it would have produced, so the picture had to degrade to
something that still carries the membership.

---

## 8. Staleness, without a fourth colour

*margin tab: 14 months old*

Brief §6.5: *"Where the graph was populated by parsing real configs, mark those nodes as such and
show their age."* `11` §8.7 sets the bands and the register — margin tab, lowercase, muted, no
badges, no progress bars, no colour.

Node age is `max(asserted_at)` over fields whose `Origin` is `Parsed` or `Imported`.
**Hand-entered and inferred values do not age** (`11` §8.7) — a human assertion is either still
true or it is wrong, and the tool has no basis to guess which. So a node a user drew is drawn in
full `--ink` forever, and that is correct: it is intent, not evidence.

### 8.1 The rendering

The channel is **G1, node boundary tone** — the only unallocated channel in §5.2's budget, and the
same device `51` §4.4 uses for severity: a contrast step, not a hue step.

| Band (`11` §8.7) | Age | Node boundary | Second label line | View band |
|---|---|---|---|---|
| Fresh | < 30 d | 1 px `--ink` | none | — |
| Ageing | 30 d – 6 mo | 1 px `--ink` | `parsed 4 months ago`, zoom > 0.6 | — |
| **Stale** | 6 mo – 18 mo | **1 px `--muted`** | `parsed 11 months ago`, zoom > 0.6 | counted |
| **Unverified** | > 18 mo | **1 px `--muted`** + a 1 px `--muted` rule beneath the node, `--s1` below | `last parsed 2025-03-11`, **at every zoom** | `3 nodes unverified` |

Four properties worth naming:

1. **It degrades correctly with zoom.** The second label line disappears below 0.6 and the tone
   step does not, so at a zoomed-out overview a user still sees which region of the estate is old —
   which is exactly the question you ask at that zoom. The count in the view band covers the case
   where the tone step is too subtle at 0.3×.
2. **`--muted` on `--page` is 5.77:1**, comfortably above 1.4.11's 3:1 for a meaningful graphic,
   and `--ink` vs `--muted` is 3.12:1 in light — above the 3:1 needed to tell the two states apart.
   **In the dark theme that pair is 2.38:1 and fails** (`55` §2.5 F3), which is why the second
   label line is not optional in dark: `--dg-age { display: block }` at every zoom under
   `prefers-color-scheme: dark`, exactly as it is under `forced-colors`.
3. **No fourth colour, no icon, no badge, no clock glyph.** The card would not have drawn one.
4. **The finding is not softened.** `11` §8.7: a stale finding still fires, at full severity. What
   changes is that the remediation leads with `show configuration | display set | match <stanza>`
   before it leads with the fix, and the `Unverified` band adds the card's own device — a
   disclaimer that is also the most useful sentence on the page:

```
RE-PARSE BEFORE ACTING — THIS EVIDENCE IS 14 MONTHS OLD
```

### 8.2 The cost

A `--muted` node boundary next to an `--ink` one reads, at a glance, as *de-emphasised* — as if the
node were disabled or filtered out. It is not; it is old. There is no way to draw "less certain"
that does not also read as "less important", and inverting the ramp (old nodes drawn *heavier*)
would be worse, because then the freshest and most trustworthy part of the picture is the faintest.

The mitigations are the second label line and the view band's count. Neither fully removes the
misreading, and it is listed in §11 as the failure mode most likely to generate a support question.

---

## 9. Export

*margin tab: it leaves the workspace*

### 9.1 The exfiltration frame, first

An exported diagram is **plaintext topology leaving an encrypted workspace**. `17` §15.1 divides
exports into sealed (still ciphertext) and plaintext (everything else), and a `.svg` or `.png` of a
network is unambiguously the second.

**PROPOSED CHANGE to `17` §15.2 — add two rows to the plaintext format table:**

| `--format` | Contents | Sensitivity, per `31` §2.1 |
|---|---|---|
| `svg` | The visible scene: device names, interface names, addresses, VLANs, zones, tunnel endpoints, peer addresses | **V3–V8.** A topology map is a targeting document. It is less deep than `review` and **more circulated than anything else the product produces**, because a picture is what goes in the slide deck |
| `png` | The same, rasterised | Same, minus text extractability — which is not a security property |

The ranking argument matters and it is not the intuitive one. `17` §15.1 establishes that a
findings export is more dangerous than a config export, because *"a findings list is a ranked
assessment with remediation syntax attached."* A diagram is less dangerous than either by depth —
and more dangerous than either by **circulation**, because a diagram is the artifact that gets
pasted into tickets, decks, wikis and vendor emails. Risk is depth × circulation, and the diagram's
second term is the largest in the product.

**Therefore: the full §15.3 gate applies, unchanged.** Passphrase re-entry, the export gate's
`Weakening` interlock, a typed reason of at least 20 characters, and a typed scope confirmation:

```
EXPORT A DIAGRAM OF 12 DEVICES AND 4 TUNNELS IN PLAINTEXT
```

An `ExportRecord` is appended before the file is written, with `format: Svg | Png`, the digest of
the bytes, and the layer mask — because "what was in the picture" is the scope for this format.

### 9.2 Three rules that are specific to a picture

**Rule 1 — the export contains exactly the visible set, and nothing else.**

A user who has turned the security layer off and exports believes the zones are not in the file. If
we serialise the whole scene and hide the inactive layers with an attribute, they are. **That is a
disclosure the user did not make and did not know they made.** So:

```
export(scene, layer_mask)  serialises only elements where element.layers ∩ layer_mask ≠ ∅
```

and the exported header states the mask. The same rule covers aggregation: if the view has
aggregated above 2,000 elements (`44` §4.7.4), the export contains the aggregate, not the
underlying detail.

**Rule 2 — no workspace identifiers in the file.** The live tree carries `data-id` with the node's
`fathom:device:<ulid>`. The export does not. ULIDs are opaque but they are **correlatable**: two
diagrams exported six months apart, or by two people, can be joined on them, and a ULID also
encodes its creation timestamp. There is no round-trip import (§1.3), so nothing needs them.

**Rule 3 — the export is re-serialised from the builder, not `outerHTML`'d from the live tree**
(`34` §5.6). The live tree carries selection state, focus rings, hover classes and `aria-hidden`;
none of that belongs in a file. More importantly, `34` §5.6's framing is the right one: *"an
exported `.svg` is a file that will be opened in a browser later, possibly by someone else,
possibly from a share. It inherits none of our headers. Treat it as hostile output we are
responsible for."*

### 9.3 SVG — and the font problem

The export is the closed tag set, presentation attributes only, no `<script>`, no `<style>`, no
`<image>`, no `href`, no `<foreignObject>`.

**No `<style>` means no `@font-face`, which means the exported SVG cannot carry our bundled DejaVu
Sans Mono.** It carries a `font-family` presentation attribute naming the stack, and a machine
without DejaVu falls back.

Because §2.4 baked label widths into coordinates using DejaVu's 0.6021 em advance, a fallback with
a different advance shifts label right edges by `Δadvance × chars × size`. For a 20-character label
at 12.5 px, a 0.005 em advance difference is **1.25 px**. Tolerable; most monospaced faces sit very
close to 0.6 em.
<!-- VERIFY: measure the advance width of the digit zero in Menlo, Consolas, SF Mono, Liberation
     Mono, Courier New and the default `monospace` on each of the three engines, and record the
     worst-case Δ against DejaVu's 0.6021 em. If any common fallback is beyond about 0.61 em, the
     arithmetic above is wrong by enough to overlap labels, and §9.3's default flips to
     text-as-paths. -->

Two ways out, and the second is opt-in:

| | Default | `--text-as-paths` |
|---|---|---|
| Text | `<text>` with the mono stack | `<path>` outlines |
| Selectable, searchable, screen-readable in the exported file | **yes** | no |
| Identical rendering everywhere | no — fallback shift | **yes** |
| File size | baseline | substantially larger |
| Cost to build | none | a glyph-outline extractor in the core, over the WOFF2 subset already in the bundle |

**DECISION — default to `<text>`.** An exported diagram that a screen reader can read and a
reviewer can `grep` for a hostname is worth more than pixel-exact typography, and the shift is
about a pixel. `--text-as-paths` exists for archival and print-house cases and is not built for
v1.

The exported file also carries the plaintext header (`17` §15.5) twice, per `34` §5.6: as an SVG
`<title>` at the root, and as a visible `<text>` banner across the top of the picture, in mono, in
`--ink`:

```
THIS FILE IS PLAINTEXT. EVERY PROTECTION THE WORKSPACE HAS ENDS HERE.
site-b · 12 devices · 4 tunnels · layers physical, L3, overlay
exported 2026-07-28T09:14:02Z · fathom 3.1.4 · 3 nodes unverified
VERIFY AGAINST YOUR OWN BOX BEFORE ACTING
```

The `3 nodes unverified` line is not decoration. A printed or exported diagram has no hover, no
inspector and no view band, so the staleness count has to be in the artifact or it is lost — and a
stale diagram circulated without its age is exactly the rot brief §2.2 warns about.

**The topology digest ships with every SVG export.** `55` §4.5.7's text serialisation of the
visible scene is written into the root `<title>`, after the header block, as plain text. Three
consequences, all of them good: the exported file has a text alternative that is not a token
label; a reviewer who receives the `.svg` can `grep` it for a hostname; and a screen-reader user
who is sent a diagram in a ticket gets the same structure the application would have given them.
It costs a few kilobytes of text in a file that is already text.

### 9.4 PNG — and why it is the lower-fidelity option

The only rasterisation path available without a second renderer is: serialise the SVG → `Blob` →
`URL.createObjectURL` → `<img>` → `canvas.drawImage` → `canvas.toBlob`.

Two consequences, both of which have to be said out loud rather than discovered:

1. **CSP.** This needs `img-src 'self' blob:`. `34` owns the policy and this is a request against
   it, not a decision this document may take alone. <!-- VERIFY: confirm with 34 whether `img-src`
   already permits `blob:`, and confirm on all three engines that drawing a same-origin blob SVG
   into a canvas does not taint it for `toBlob`. Historically some engines treated SVG-in-img
   conservatively. If any engine taints, PNG export is not available on that engine and the UI must
   say so rather than producing a broken file. -->
2. **Fonts.** An SVG loaded through an `<img>` is an isolated document. **It cannot see the page's
   `@font-face` rules**, so the text renders in whatever the system's default monospaced face is.
   The label-shift arithmetic in §9.3 applies, on the rasterising machine, with no fallback stack
   to control it.

**DECISION — PNG is documented as the lower-fidelity export, and the UI says so at the point of
export, once, as a margin tab:**

```
png · rasterised with the system mono · use svg or print for exact type
```

The rejected alternative — a first-party rasteriser drawing the scene straight from the layout data
into an `OffscreenCanvas` — is a **third renderer**, and `44` §4.7.3 already prices a second one as
a permanent maintenance obligation. A third is not defensible for a convenience format.

### 9.5 Print

`51` §13 owns the print stylesheet and the diagram inherits it:

| | |
|---|---|
| Page | `size: letter landscape; margin: 24pt` — the card's own geometry |
| Scale | The scene is scaled to fit 744 × ~500 pt, once, with the scale factor printed in the folio: `scale 0.42` |
| Layers | Exactly the visible set (§9.2 rule 1) |
| Legend | The risk legend prints on every page (`51` §13.5) even though the diagram uses no risk colour — because the printed sheet may also carry a config block, and a page without the legend is unreadable |
| Header | The `17` §15.5 block, as the SVG banner |
| **Stale nodes** | Printed as a **table below the picture**, not only as a tone step: a printed page has no hover, and a `--muted` stroke at 0.42 scale is not a reliable signal on a laser printer |
| Labels hidden by §5.5 | Also printed as a table. On paper there is no view band to carry the count |
| Colour | `print-color-adjust: exact` is irrelevant here — the diagram is already ink on white |

The two tables are the print-specific work and they are the reason a printed Fathom diagram is
*more* honest than a screenshot: the things the picture could not say are written underneath it.

---

## 10. Performance

`44` §4.7 owns the budgets. This document adopts B12 and B13 unchanged and adds the counters that
gate the parts specific to this design.

| Counter | Ceiling | What it catches |
|---|---|---|
| `svg_elements_live` | **2,000** | The aggregation threshold, gated (`44` §4.7.4) |
| `svg_attrs_written_per_pan_frame` | **1** | The single most valuable counter in this document. `44` §4.7.1's one-attribute pan is easy to write and easy to regress into a per-element re-projection |
| `layout_sweeps` | **8**, exactly | An adaptive termination criterion sneaking into phase 5 — a determinism bug that no timing test would catch |
| `layout_calls_per_second` | **5** | X15's budget (`41` §3.2). A layout call on a drag frame |
| `label_candidates_tested` | 4 × labels | Label placement degenerating into a global optimiser |
| `hit_test_candidates` | **32** | The uniform grid's cell size drifting until a query scans the scene |
| `outline_rows` | `== svg elements` | `55` §4.5.8's bijection, as a counter as well as a test |

**Two failure modes that are counters rather than timings**, because `44` §1.1's argument applies:
the product is deterministic, so its work counters are deterministic, so they can be asserted
exactly on a noisy shared runner where a millisecond cannot.

---

## 11. Failure modes

| # | Failure | What it looks like | What you will wrongly blame | The fix |
|---|---|---|---|---|
| 1 | A property is stored on a shape instead of on a node | Two users see different edge types for the same link; export loses it | "the diagram state is buggy" | §0's governing rule. The only view-local state is the transform and the layer mask |
| 2 | Layout re-run on a drag frame | The diagram stutters at 20 nodes, not at 500 | "SVG is slow" | §6.3, and the `layout_calls_per_second` counter |
| 3 | Pan implemented by re-projecting coordinates per element | 1,712 attribute writes per frame | "we need Canvas" | `44` §4.7.1, and `svg_attrs_written_per_pan_frame` |
| 4 | Crossing reduction given an adaptive stop condition | Two builds produce different pictures from the same workspace; the export digest changes | "floating point" | §3.3 phase 5. Fixed sweeps, `NodeId` tie-break |
| 5 | Phase 5 seeded from scratch instead of from the previous ordering | One added device rearranges the whole picture | "automatic layout is bad" | §3.5. It is one array copy |
| 6 | A layer toggle moves nodes | Users stop using layer toggles within a week | "the layers are confusing" | §3.6 — one scene, filtered. Toggles reveal, commands rearrange |
| 7 | Zone drawn as a wash or a fill | It disappears entirely under `forced-colors` | "high contrast mode is broken" | §4.4 — stroke only, never fill-only |
| 8 | A dashed line used for tunnels or logical links | AI-proposed elements become indistinguishable from real ones | "the dash was the obvious choice" | §5.2 G2. Dash is spent. The conduit is the answer, and it is better |
| 9 | Labels overlapped instead of counted | The picture looks full and reads as noise | "too much detail" | §5.5 — place four candidates, count the rest, show the count |
| 10 | A stale node's `--muted` boundary read as "filtered out" | Users ask why half their estate is greyed out | "the filter is stuck" | §8.2. The second label line and the view-band count are the mitigation, and they are not optional in dark |
| 11 | Export serialises the whole scene with hidden layers marked hidden | A user exports a picture believing the security layer is not in it, and it is | "we exported what was there" | §9.2 rule 1 |
| 12 | A new decoration added with no Outline row | A screen-reader user reports a missing device | "the Outline is out of date" | §7 — the bijection test fails the build |
| 13 | `vector-effect` omitted | Hairlines become slabs at zoom 3 and the focus ring stops being 2 CSS px | "the zoom is broken" | §5.3, §6.2 |
| 14 | Someone widens `34` §5.6's tag set for `<marker>` or `<use>` | A script sink or a fetch appears in an exported file | "it is only a marker" | §5.4. Arrowheads are line segments in the same path |
| 15 | The connect gesture fills in a DH group so the config "just works" | A value nobody chose, provenance `Hand`, and a rule that reads it as intentional | "it was a sensible default" | §6.4.3, and `11` §8.5 |

---

## 12. Open decisions

**DECISION — build order (§3.4).** Grid placement + orthogonal routing + drag first; layered layout
(phases 3–6) as separately-scoped later work. **RECOMMENDATION — take it.** `41` §4.5b already
says so: *"shipping a diagram that lays out badly and lets you fix it by dragging is better than
not shipping a diagram."* The `LayoutHint` type and the pin semantics must exist from day one
regardless, because retrofitting pins into a layout that assumed it owned every position is a
rewrite.

**DECISION — vendoring a layout library.** `34` §8.2 permits one only if it returns coordinates and
never touches the DOM, vendored, pinned and compiled in. The two obvious candidates are JavaScript,
which puts layout on the wrong side of the boundary and breaks the CLI's shared use of it (`41`
§4.5b). **RECOMMENDATION — write it in Rust in `fathom-layout`.** Sugiyama's phases are well
documented, the graph is small, and the determinism requirements are ours.

**DECISION — concurrent layout edits (`52` §12 D5).** Position is a class B LWW field (`33` §6.4).
**RECOMMENDATION — LWW, and add per-user layout overlays only if "my colleague moved my boxes"
actually arrives.** Speculative multi-user layout state is expensive and usually unwanted.

**DECISION — the CSP change for PNG export (§9.4).** `img-src 'self' blob:` is a request against
`34`. If it is refused, PNG export does not exist, and the honest answer is SVG plus print-to-PDF.
That is a defensible product position and it should be taken loudly rather than worked around.

**Open, not decided — a "planned versus observed" treatment.** The graph mixes intent (hand-drawn)
with evidence (parsed) and §8's age treatment distinguishes them only indirectly, because only
parsed nodes age. A user drawing a change on top of a parsed estate may want to see, explicitly,
which boxes are proposals. The channel budget (§5.2) has nothing free, and G2 (dash) is already
AI-proposed — which is a *different* meaning that would be confused with it. **RECOMMENDATION —
do not add a channel. If this is needed, it is a filter (`show only elements created since <date>`)
with the count in the view band, not a treatment.**

**Open, not decided — the second `TunnelInterface` unit problem.** `BindsInterface` is `in: 0..1`,
so `st0.0` holds one VPN. A hub with 40 spokes has `st0.0` through `st0.39`, and drawing 40 units
on one device box is a texture. Candidate: collapse `st0.*` into one stub with a count and expand
on drill-down, which is `44` §4.7.4's aggregation applied at the unit level. Needs a design pass
and a hub fixture.

---

## 13. PROPOSED (2026-08-08) — zoom, containment, and the ladder of places

*margin tab: proposed, not decided*

> **Status of this section: PROPOSED, in its entirety.** Nothing in it amends a DECISION above.
> §13.6 is a **reversal** of one row of §1.3's out-of-scope column and is marked as one. Everything
> else adds.
>
> **Where the record is.** The owner's words are quoted verbatim in `70` §10.5 and are not repeated
> here; `70` §§10.6–10.12 record the resolution and the open decisions it opens (`70` §13 items
> 16–21). This section is the **design reading** of that record, in this document's idiom, because
> this document owns the diagram.

### 13.1 What this section amends, and what it leaves alone

| | |
|---|---|
| **Amends** | §1.3's out-of-scope row, on one item only — *background images* — see §13.6 |
| **Adds to** | §1 (a zoom axis the scope section does not have), §4 (a rule about which relations may be enclosed) |
| **Leaves untouched** | §3.6's DECISION (one scene, filtered), §3.2's DECISION (layered layout, manual positions as constraints), §4.1's projection table, §4.3–§4.5's choice of box / bracket / band, §4.7's rule that an attribute of elements is a treatment and not a layer |

### 13.2 PROPOSED — zoom and view are two independent axes

| Axis | Values | State |
|---|---|---|
| **Zoom** | inside-a-device → rack → floor → building → map | **New.** The model half is a proposal — §13.4 |
| **View** | physical / L2 / L3 / security / overlay | **Decided.** §4, five layers, a 5-bit `LayerMask` |

They **compose**. Five views against five zoom stops is twenty-five pictures if they are enumerated
and two mechanisms if they are not, and **there is no per-combination design in this proposal.**

§3.6 already argues the layer half and the argument transfers without modification: one layout,
computed over the union, *filtered* — because the alternative is *"31 layouts, 31 sets of positions
to store, and a view where turning on the security layer rearranges the physical one."* The same
sentence with *zoom stop* substituted for *layer* is the proposal. What it costs is the same cost
§3.6 already accepted and named: a filtered view is laid out to accommodate things it is not
drawing, so it looks sparse, and it buys a stable picture a user can build a mental map of.

**One collision of names, which is the reason the axes must be separated explicitly.** *Physical* is
a **view** in §4.1 and, in ordinary speech, also the **innermost zoom stop** — one device, seen
inside. Two axes wearing one word is how twenty-five pictures get designed by accident.

**Not settled by this section:** whether the zoom stops are discrete rungs or a continuous scale with
labelled detents. `76` §10 already carries the related unowned item — *"What binds continuous zoom?
`53` §3.4 binds only `z`; `56` depends on zoom thresholds throughout"* — and `53` owns the keymap
under ADR-0024. The two should be answered together.

### 13.3 PROPOSED — zoom is navigation; containment is structure

**Zooming into a device must not create a parent-child relation the graph does not have.** §0's
governing rule is the whole control: if a fact exists only in the picture, the picture has become the
data structure.

And inside a device, things do not nest, because the model says a unit is several things at once.
From `schema/schema.yaml`, read 2026-08-08:

| Relation | Class | Cardinality | A `LogicalUnit` is… |
|---|---|---|---|
| `HasUnit` — `InterfaceLike → LogicalUnit` | `containment` | `in: "1"` | in exactly one interface |
| `ZoneMember` — `Zone → LogicalUnit` | `reference` | `in: "0..1"` | in at most one zone |
| `InRoutingInstance` — `LogicalUnit → RoutingInstance` | `reference` | `out: "0..1"` | in at most one routing instance |
| `VlanMember` — `LogicalUnit → Vlan` | `reference` | `in: "0..n"` | **in many VLANs at once** |

> **PROPOSED R-Z1 — nothing is drawn as an enclosure for a relation a node can be in twice.**
> Exactly one of a node's memberships may be drawn as containment; every other is an overlay over
> the same positions. `VlanMember` at `in: "0..n"` is the case that proves the rule is needed and
> not merely tidy: a thing cannot be inside two boxes.

**§4 already obeys R-Z1** — §4.5's VLAN band is an open horizontal bracket, not a closed box, and it
is suppressed above six visible VLANs precisely because overlapping bands are a texture.

**What §4.1 does *not* do, stated so this proposal is not mistaken for a description of it.** §4.1
does not assign marks by edge class. `Site` is reached by **containment** (`HasDevice`, `in: "1"`)
and is drawn as a **band**; `RoutingInstance` is reached by a **reference** edge
(`InRoutingInstance`) and is drawn as a **box** (§4.3). The basis for box / bracket / band in
§4.3–§4.5 is **contiguity of members**, not edge class, and that basis is defensible and is not
disturbed here. R-Z1 is the narrower rule that survives both readings, and it is the only one this
section asks for.

### 13.4 PROPOSED — the place ladder, as a schema proposal this document does not make

The rack / floor / building / map rungs need somewhere to live in the graph. **`19` and `62` own
that, not this document**, and the proposal is recorded in `70` §10.8 in full: widen `HasPremises`
from `from: [root]` to `from: [root, Premises]`, keeping `in: "1"`, so `Premises` nests and
containment stays a forest.

Two consequences land **here**, on the picture, and are worth stating before the schema question is
answered rather than after:

1. **A zoom stop is not automatically a mark.** A floor is a `Premises` under the proposal, and a
   `Premises` has members. Whether it is drawn as a box, a bracket or a band is §4.3–§4.5's
   contiguity question all over again, and by R-Z1 it may be an enclosure — `HasPremises` is
   containment at `in: "1"`. Nothing here decides which.
2. **The place tree and the device tree do not meet by containment.** `HasDevice` is
   `Site → Device`, `in: "1"`, and `AtPremises` is a **reference** from `Site` to `Premises`. So a
   rack drawn as an enclosure around devices is drawing a relation the graph does not currently
   have. Under §0's governing rule that is not a rendering detail — it is the picture inventing
   structure. **Until `70` §13 item 16 is answered, the bottom rungs of the ladder have no model.**

### 13.5 One workspace is one estate — what that removes from this document

`70` §10.9 records the owner's answer to `76` §8 Q1: a *network* crosses places, so it is a **bag**,
not a container. For this document that closes a question §1 never had to ask and would eventually
have been asked: **there is no second canvas, because there is no second graph.**

It does **not** answer §12's live item on whether the diagram partitions per `Site` — `70` §10.2
already logged that, and `70` §13 item 9 keeps the recommendation that it be decided against a
running diagram rather than on paper. A per-`Site` **view** is a filter over one graph; a per-network
**container** would have been a second graph. Only the second is refused.

### 13.6 REVERSAL, PROPOSED — a background image is a spatial reference, not decoration

§1.3's out-of-scope column reads:

> *"Free-floating annotations, text boxes, arrows that are not edges, clip art, background images"*

**PROPOSED — strike `background images` from that list, for a place-scoped view only, and leave the
rest of the row exactly as it is.**

**The argument.** Every other item in that row is **decoration** — a mark that is not a statement
about anything, which floats over a picture and decays into graffiti. A floor plan is not
decoration: it is the thing the positions are positions *in*. It gives a coordinate a meaning, which
is the opposite of what the rest of the row does. (This is the same distinction `70` §10.3.2 used to
separate a `tag` — a user-authored fact about a real device — from the annotations in the same row.)

**Four costs. They are not counter-arguments to be dismissed; they are the price, and the fourth is
unanalysed.**

| Cost | Detail |
|---|---|
| **Size, and it is the only unbounded thing in the file** | `44` owns size budgets; its gate (`44` §5.5) covers build artifacts — `A1 ≤ 4.5 MB`, WASM, index, pack — and **nothing in it covers workspace content**. `17` §13.2 puts a 50-device hand-modelled workspace at 0.6 MB and a realistic mix at 8 MB, under its own §13.1 recomputation caveat. An imported image's size is chosen by the user. `44` §5.1's binding constraint is distribution: *"a 4 MB attachment goes through email; a 40 MB attachment does not"* |
| **Opacity, in a file where everything else carries provenance** | Parsed values carry their originating line and their age (§8, `11` §8.7); typed values carry `Origin::Hand`. **Nothing can tell whether an image is current or of the right building.** §1.2's *"The view never says 'current'"* bites harder here than anywhere else in this document, because a wrong field usually looks wrong and a wrong floor plan does not |
| **No export carries it** | §9.3 and `34` §5.6 both ban `<image>` from the closed tag set. The background is in the application and **in none of the exports**. §9.2 rule 1 already requires the export to be exactly the visible set with the header stating what it is — **so the header must say the background was dropped**, at export time, not afterwards |
| **A decoder enters the trust boundary and nobody has looked at it** | A user-supplied image is bytes handed to the browser's decoder. `34` has **no section on image decoding** — grepped 2026-08-08 for *decoder*, *jpeg*, *bitmap*, *raster*: zero hits. The surface is **unanalysed, not cleared**, and **no claim is made here in either direction**: ADR-0034 forbids answering it from memory. `70` §13 item 19 puts it to `34`'s owner |

**What it does not cost: a CSP change.** `34` §2.7 (read 2026-08-08) fixes `img-src` at `data:` in
mode A and `'self' data:` in modes B–D, retaining `data:` deliberately because the diagram export and
the risk legend need inline SVG data. **A `data:`-URI background is inside the existing policy.** That
is the difference between this request and §9.4's, which asks for `img-src 'self' blob:` and is a real
widening — §15 disagreement 3 already says `34` is entitled to refuse that one.

**Three constraints that travel with the reversal if it is taken:**

1. **It is a rendering, like everything else here.** The image is graph data — an attribute of a
   `Premises` — never view-local state, or §0's rule has been broken to hold a picture of a floor.
2. **It never carries a finding, a colour or a claim.** It sits behind the scene. The risk enum's
   three reserved colours (`51` R1) are not spent on it and are not tinted by it.
3. **It is per place, not per canvas.** A background that is not scoped to a place is exactly the
   free-floating decoration the rest of the row refuses.

**`70` §13 items 17 and 18 carry this.** It is not decided; this document owns the answer and has not
taken it.

### 13.7 The line at simulation, stated so it is not drifted across

The owner's ladder puts *"control vs dataplanes"* inside the innermost zoom stop, with the qualifier
that matters: *"though not everything has that separation"* (`70` §10.5).

**In scope — structure.** That a platform separates a control plane from a data plane is a fact about
that platform. Under invariant 5 and ADR-0008 it is **corpus content, per platform**, authored and
reviewed by a named human under invariant 10 — **never a shape this renderer assumes.** Where the
corpus does not assert it, the device draws as one section, which is §13.8's rule and is already how
everything else in this document behaves.

**Out of scope, permanently — simulation.** `11` §2.2 rejects control-plane and data-plane simulation
and states the consequence in the same row: *"Fathom cannot answer 'where does this packet go'."*

> **Showing that a box has two planes is structure. Predicting which one a packet traverses is
> simulation. The first is in scope; the second is refused and always was.**

They are one word apart in ordinary speech, which is the entire reason this paragraph exists.

### 13.8 *"Show what is available"* — already the rule, restated so it is not relaxed

The owner's *"if there is no information or little then just show what is available"* asks for
behaviour this document and its neighbours already specify, so **nothing is built for it and nothing
may be quietly traded against it**:

- The model is **partial by construction** — `11` §2.2's four-state `Presence`, which it calls
  *"the single largest structural divergence in this document"*.
- **What is dropped is counted** — §5.5: *"a diagram tool that silently drops labels is a diagram
  tool that lies about what it drew."* `59` §6.2 files the one place the base breaks it.
- **A gap is never filled with a guess** — §11 failure mode 15, §6.4.3, `11` §8.5. A sensible default
  is a value nobody chose with provenance `Hand`.

### 13.9 What this section deliberately does not decide

| | Why not |
|---|---|
| The mark for a place at any zoom stop | §4.3–§4.5's contiguity question, and it needs a fixture, not a paragraph |
| Whether zoom is continuous or detented, and what binds it | `53` owns the keymap (ADR-0024); `76` §10's existing unowned item on continuous zoom is the same question |
| Whether the diagram partitions per `Site` | §12 and `70` §13 item 9 — to be decided against a running diagram |
| Anything under `schema/` | `62` governs; ADR-0008 decides what exists. §13.4 is a proposal recorded in `70` §10.8 and **no schema file was touched** |
| The image-decoder surface | `34` owns it, ADR-0034 governs how it is answered, and §13.6 does not answer it |

## 14. Sources consulted

- `.context/field-card-srx-ipsec.txt` — the object chain and the five plumbing pieces (§6.4.2),
  `external-interface` versus `st0` (§6.4.2), route-based versus policy-based (§4.6), the
  `reth0.0` / `st0.0` topology used as the worked example throughout.
- `.context/design-language.md` — no icons, no colour beyond the risk enum, the margin-tab
  register, the one-line imperative, hairlines and mono.
- `docs/10-core/11-ir-schema.md` §6 (kinds), §7 (edges, including `Link` as an edge and
  `ZoneMember` as an edge with fields), §8.5 (what may assert `Absent`), §8.7 (the staleness
  bands and their register), §10.6 (what survives a rename).
- `docs/40-stack/41-technology-choices.md` §3.2 (X15/X16 and their call budgets), §4.5b (layout in
  the core, the pan transform, the uniform-grid hit test, the `LayoutHint`, and the build-order
  recommendation this document adopts).
- `docs/40-stack/44-performance-budgets.md` §4.7 (B12, B13, the element inventory, level of detail,
  the canvas drag fallback, and the 2,000-element aggregation decision).
- `docs/30-security/34-browser-hardening.md` §5.6 (the closed SVG tag set, no `foreignObject`, no
  `use`, no `image`, export re-serialised from the builder, the plaintext header requirement) and
  §8.2 (the conditions under which a layout library may be vendored).
- `docs/10-core/17-workspace-format.md` §15 (the plaintext export gate, the `ExportRecord`, and the
  header block §9.3 reproduces).
- `docs/50-design/51-design-tokens.md` §4 (the channel-budget method §5.2 copies), §9 (the three
  rule weights and the reservation of dashed and dotted), §12 (motion), §13 (print).
- `docs/50-design/52-information-architecture.md` §3.6, §5, §9.3 (the view's place, the selection
  model, the view band).
- `docs/50-design/55-accessibility.md` §4.5 (the Outline, which §7 implements), §5.2 (the focus
  ring inside the SVG), §5.5 (the drag alternatives), §7.3 (forced colours in SVG), §2.5 F1 and F3
  (why `--hairline` may not bound anything here and why §8 needs the second label line in dark).
- MDN, `vector-effect` — `non-scaling-stroke`, a presentation attribute with a CSS counterpart,
  Baseline since 2020. §5.3 depends on it.

Added for §13 (2026-08-08):

- `docs/70-ops/70-owner-answers-and-standing-priorities.md` §10.5 (the owner's four quotations,
  verbatim — the record §13 reads), §§10.6–10.12 (the resolution), §10.3.2 (the decoration /
  statement distinction §13.6 reuses), §13 items 16–21 (the open decisions §13 opens).
- `schema/schema.yaml`, read 2026-08-08 — `edge: HasUnit` (`containment`, `in: "1"`),
  `edge: ZoneMember` (`reference`, `in: "0..1"`), `edge: InRoutingInstance` (`reference`,
  `out: "0..1"`), `edge: VlanMember` (`reference`, `in: "0..n"`), `edge: HasPremises`
  (`containment`, `from: [root]`), `edge: AtPremises` (`reference`, `Site → Premises`),
  `edge: HasDevice` (`containment`, `Site → Device`, `in: "1"`). §13.3's table and §13.4's second
  consequence are read directly off these.
- `docs/10-core/11-ir-schema.md` §2.2 — the rejection of the total-population assumption, and the
  rejection of control-plane / data-plane simulation with its consequence, *"Fathom cannot answer
  'where does this packet go'"*. §13.7 and §13.8.
- `docs/30-security/34-browser-hardening.md` §2.7 (the `img-src` directive, `data:` in mode A and
  `'self' data:` in B–D, and why `data:` is retained) and §5.6 (the closed tag set's ban on
  `<image>`), read 2026-08-08. §13.6.
- `grep -rniE "image decod|decoder|jpeg|bitmap|raster" docs/30-security/34-browser-hardening.md`,
  run 2026-08-08 — **zero hits**. §13.6's fourth cost: unanalysed, not cleared.
- `docs/40-stack/44-performance-budgets.md` §5.1 (distribution as the binding size constraint) and
  §5.5 (the size gate's scope — build artifacts, not workspace content). §13.6.
- `docs/10-core/17-workspace-format.md` §13.1 (the pending recomputation caveat) and §13.2 (the
  derived 0.6 MB / 8 MB workspace figures). §13.6.
- `docs/10-core/19-service-and-physical-model.md` §3.5 (`Premises`, its `form` enum, and the
  two-hop sibling query) and §5.1 (the `HasExternalPeer` widening precedent). §13.4.
- `docs/70-ops/76-scope-expansion-analysis.md` §8 Q1 and Q2 — the network question §13.5 records as
  answered, and the sealed-container consequence that answer removes.

## 15. Disagreements

None with the binding conventions. Three notes:

**1. `51` §9's reservation of the dashed rule shaped this document more than any other constraint,
and it improved it.** The obvious drawing for a tunnel is a dashed line; it is what every network
diagram has used for thirty years. Being unable to use it forced §4.6's conduit, which is a better
drawing: it is unambiguous at any zoom, it survives forced colours, it survives monochrome print,
and it says "a pipe inside a pipe", which is what a tunnel is. This is recorded because a future
editor will find the conduit surprising and reach for the dash.

**2. Proposed change to `17` §15.2** — add `svg` and `png` to the plaintext export format table,
ranked V3–V8, with the full §15.3 gate. Argued in §9.1. It is a proposed change rather than a
disagreement because `17` §15.2's table is an enumeration, not a convention, and a format missing
from it is an ungated export path.

**3. A request against `34`** — `vector-effect` must be added to §5.6's permitted presentation
attributes, and §9.4 asks for `img-src 'self' blob:`. The first is a rendering necessity with no
security surface. The second is a real widening of the policy for a convenience format, and `34`
is entitled to refuse it.
