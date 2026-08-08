# 59 — Diagram aggregation, and the colour decision

> **Status:** Proposed

Companion documents: `50-design/56-diagram-view.md` (**the owner of the diagram**; this document
closes its §12 open decision on the second `TunnelInterface` unit and proposes one amendment to its
§5.2 channel budget, and changes nothing else in it), `40-stack/44-performance-budgets.md` §4.7.4
(the 2,000-element aggregation decision — §2 below proposes an amendment to it),
`50-design/52-information-architecture.md` §3.6.1, §9.3 (the IA consequence of aggregation, and the
view band that has to report it), `50-design/51-design-tokens.md` §1 R1, §3.2, §3.3, §6, §13, §14
(the risk reservation, the reservation lint, forced colours, print, and the token file §5 proposes
an addition to and does not edit), `50-design/55-accessibility.md` §3 (colour independence and the
monochrome test), §4.5 (the Outline), §7.3 (forced colours in SVG),
`50-design/53-interaction-and-keyboard.md` (**the sole owner of the keymap** per ADR-0024 — this
document binds no keys and §3.8 is a request against it), `50-design/54-component-catalog.md` §8,
§13, §17 (the disclosure contract: `aria-expanded` + `aria-controls` + `hidden`),
`50-design/58-ui-direction-study.md` §2.3, §4 (round one's concept 03, which chose eight and had no
layout underneath it, and the ADR-0006 collision this document's §11 restates),
`90-decisions/adr-0011-risk-is-a-property-of-effect.md` (invariant 11, which §4 refuses to spend),
`90-decisions/adr-0006-v1-is-the-finder-and-the-product-is-phases-0-to-3.md` and
`70-ops/71-roadmap.md` §7 (which put this view in phase 4 — §11 argues the case that this work is
premature, in its strongest form).

The owner's verdict on round two, in full, because both halves of this document are a reading of it:

> *"i don't hate it but when you have a ton of them we should probably collapse them into a +#
> icon? but if you want to add colors make a model or two to see what it'll look like."*

**The governing rule of this document, stated once, in caps, at the top:**

> **AGGREGATION IS NOT AN OPTIMISATION. IT IS THE STATEMENT THAT FORTY IDENTICAL THINGS ARE ONE
> FACT, AND A DIAGRAM THAT DRAWS THEM FORTY TIMES HAS FAILED TO SAY IT. A COLLAPSE THAT DOES NOT
> NAME WHAT IT HID AND HOW MANY THERE WERE IS NOT A BETTER DIAGRAM — IT IS A LIE WITH FEWER
> ELEMENTS.**

Three variants were built on top of `design/diagrams/A-schematic.html`, driven in Chromium under
Playwright, and adversarially reviewed. **Every number in this document was re-measured for it**,
in Chromium 1194 via Playwright over `file://` at DPR 2, 1440 × 1200, against the files as they
stand; nothing is quoted from a builder's or a reviewer's report without being reproduced. Where a
measurement contradicts a claim made inside one of the HTML files, the measurement is printed and
the claim is named.

---

## 0. Contents

| § | |
|---|---|
| 1 | What was asked, what was built, and how every number here was produced |
| 2 | The legibility ceiling — a proposed amendment to `44` §4.7.4 and `52` §3.6.1 |
| 3 | **DECISION — like-kind sibling aggregation, at six.** The design pass `56` §12 asks for — plus §3.13–3.14, a **PROPOSED** sixth level for parallel edges between one pair of nodes, added 2026-08-08 |
| 4 | **DECISION — no colour.** What the three rendered data points actually showed |
| 5 | The palette, measured and shelved — a PROPOSED addition to `51` §14, not adopted |
| 6 | What the variants found in the base that has to be fixed regardless |
| 7 | What to build next, concretely |
| 8 | Failure modes |
| 9 | Open decisions |
| 10 | Sources consulted |
| 11 | Disagreements |

---

## 1. What was asked, what was built, and how every number here was produced

*margin tab: read this first*

### 1.1 The two instructions, restated

| Instruction | Reading |
|---|---|
| *"when you have a ton of them we should probably collapse them into a +# icon"* | Correct, and it is the open decision `56` §12 already carries. §3 is the design pass. **Two corrections to the wording, both load-bearing:** a bare `+#` is the failure mode, not the fix (§3.6), and it is not an *icon* — `design-language.md` and `56` §5.1 (M31) permit a closed set of typographic glyphs and no pictorial icons, so the affordance is geometry and text (§3.5) |
| *"if you want to add colors make a model or two to see what it'll look like"* | Two models were built, at full fidelity, on the same layout engine. §4 decides. The owner asked to see them in order to decide; a study that returns *"it depends"* wastes that, so §4 decides and names what the losing options would have bought |

### 1.2 The four files

All four are single self-contained HTML files, open from `file://`, link `../tokens.css`, and carry
`connect-src 'none'` and `form-action 'none'` in a CSP meta. Measured for this document: **exactly
two network requests each** — the document and `../tokens.css` — **zero console messages of any
type, zero page errors**, with every control on the page exercised. `design/tokens.css` is
untouched: its last commit is `a8007ce`, and `git status design/` is clean.

| File | What it is | Aggregation | Colour |
|---|---|---|---|
| `A-schematic.html` | Round two's strongest. The base. Layout, orthogonal router, channel allocator, crossing detector, label placer, inspector column, hover chip, Outline | none | none |
| `A2-aggregated.html` | The monochrome control. Aggregation only, threshold 8, windowed expansion | yes | none — deliberately, as the thing the colour models had to beat |
| `A3-overlay-colour.html` | Aggregation at 6, plus an opt-in overlay tier: five overlays, five hues, key generated by the choice | yes | opt-in, five hues, default off |
| `A4-zone-colour.html` | Aggregation at 6, plus always-on zone colour: hue permanently means security zone | yes | always on, five hues |

### 1.3 Method

Every element count is `svg.scene.getElementsByTagName('*').length`, read from the live DOM, not
from the page's own counter. Every hue angle is HSL computed from the resolved token value. Every
contrast ratio is the WCAG 2.x relative-luminance formula. Every greyscale byte is read out of a
PNG produced by Chromium with `filter: grayscale(1)` applied, decoded and sampled — not computed
and asserted. Keyboard behaviour was driven with real `Tab`, `Enter` and `Escape` events, not by
calling the debug API.

**One thing could not be verified and it matters in §5.6.** Playwright's `forcedColors: 'active'`
sets the media query but does not install a Windows High Contrast palette. What is verifiable is
**which declaration wins the cascade**, and that is enough to find the two bugs in §5.6 — but it is
not a substitute for looking at a real high-contrast desktop, and nobody has.

---

## 2. The legibility ceiling

*margin tab: two ceilings, not one*

### 2.1 The finding

`44` §4.7.4 decides: *"the diagram never renders more than 2,000 live SVG elements. Above that it
aggregates."* `52` §3.6.1 repeats it as an IA consequence. Both are correct and both are about the
wrong quantity.

> **THE FINDING. A-schematic renders a forty-spoke hub in 514 SVG elements — 26% of `44` §4.7.4's
> ceiling — and it is already unreadable. At its own cap of 64 spokes it renders 614, which is 31%
> of the ceiling, and by then it has stopped printing the counts of what it suppressed. The
> 2,000-element rule never fires. It is a PERFORMANCE ceiling. The corpus has never specified the
> LEGIBILITY ceiling, and the legibility ceiling is the one that bites.**

The two are not the same ceiling and neither implies the other. Both should stand.

### 2.2 The measurement

A-schematic, spoke count driven 1 → 16, everything else held constant:

| spokes | SVG elements | scene | fit zoom | what the view band says it suppressed |
|---|---|---|---|---|
| 1 | 164 | 784 × 620 | 1.00 | `2 edge labels off · 8 labels hidden` |
| 4 | 191 | 784 × 668 | 0.98 | `5 edge labels off · 8 labels hidden` |
| 6 | 209 | 784 × 700 | 0.97 | `7 edge labels off · 8 labels hidden` |
| 8 | 227 | 784 × 732 | 0.96 | `9 edge labels off · 8 labels hidden` |
| 12 | 263 | 832 × 796 | 0.93 | `13 edge labels off · 8 labels hidden` |
| 40 | **514** | 1000 × 1332 | **0.68** | `41 edge labels off · 8 labels hidden · lag rails collapsed · stubs below 6px` |
| 64 (its cap) | **614** | 1144 × 2100 | **0.43** | `edge labels off · ports collapsed · conduit collapsed · lag rails collapsed · stubs below 6px` |

Three facts fall out of that table and each one is load-bearing.

**1. The cost is exactly linear and exactly known.** Elements are `155 + 9n` for `n` drawn spokes,
reproduced to the element at every one of n = 1…14. At forty spokes the fan is **360 of the 514
elements in the picture — 70% of the drawing is one repeated fact.** The scene grows exactly 16 px
per spoke, which is `--lh-micro`, the port lattice: the picture's height is a direct function of
how many identical things the estate owns.

**2. The picture dies long before the budget does.** At 26% of `44` §4.7.4's ceiling the fit zoom
is 0.68 and 41 of 42 edge labels are gone. At 31% of the ceiling the fit zoom is 0.43, which is
below `44` §4.7.2's 0.6 threshold and closing on its 0.35 one, and the device names, the port
names, the conduit decoration and the LAG rails have all been dropped.

**3. The base breaks `56` §5.5's own rule at the top of the range, and it breaks it silently.**
Compare the last two rows. At 40 spokes the band says `41 edge labels off`. At 64 it says
`edge labels off` — **the count is gone**. `56` §5.5 is explicit: *"Labels that cannot be placed
are not drawn, and are counted… A diagram tool that silently drops labels is a diagram tool that
lies about what it drew."* The base loses the number precisely when scale makes it matter, and it
loses four more categories the same way. This is a defect in the base, it is filed in §6.2, and it
is also the sharpest possible statement of why the legibility ceiling has to be written down: the
LOD ladder is what a diagram does when it has already lost, and it degrades into dishonesty.

### 2.3 The reductio — element count cannot choose this threshold

Force the collapse rule to fire at every sibling count and measure both forms, 1 → 14 spokes:

| | element counts, 1 → 14 spokes |
|---|---|
| every one drawn | `164, 173, 182, 191, 200, 209, 218, 227, 236, 245, 254, 263, 272, 281` — exactly +9 per spoke |
| collapsed at every count | `164`, then **flat** for every count from 2 to 14 |

The aggregate is cheaper than the **second** sibling. An element-count rule would therefore
collapse `node0`/`node1` into "+2 chassis", which nobody wants and which destroys the one fact a
chassis cluster exists to show. **Element count cannot choose this threshold. Legibility has to.**

### 2.4 The amendment, as text

> **PROPOSED — `44` §4.7.4.** Retain the 2,000-element decision unchanged and rename what it is.
> Add a second, independent ceiling.
>
> **`44` §4.7.4 is the PERFORMANCE ceiling.** It gates `svg_elements_live` and it is about what the
> browser can composite. It stays at 2,000 and it stays a gated counter.
>
> **A LEGIBILITY ceiling is added, and it is the one that fires in practice.** No more than **six
> like-kind siblings** are drawn in one group. It is counted in siblings, never in elements; it is
> scale-free (nine spokes are nine spokes in a twelve-node estate and in a twelve-hundred-node
> one); and it is two orders of magnitude below the performance ceiling in element terms. The
> counter is `sibling_group_max`, ceiling **6**, gated the same way `svg_elements_live` is.
>
> **PROPOSED — `52` §3.6.1.** Its paragraph is correct and incomplete. The sentence *"an engineer
> who wants their whole 200-device estate on one screen cannot get it, and the answer is the
> inventory view"* stands. Add: **the far more common case is not 200 devices, it is one device
> with forty of something on it, and for that case the answer is not the inventory view — it is the
> collapsed group with a count and a drill-down, in the diagram, where the question was asked.**

### 2.5 What the two ceilings do together

With the legibility ceiling in force the drawing stops being a function of estate repetition.
Measured, on `A2-aggregated.html`, holding everything else constant:

| spokes | aggregated | un-aggregated |
|---|---|---|
| 4 | 192 el · 784 × 668 · fit 0.98 | **identical** — four is below the threshold, nothing fires |
| 12 | 172 el · 812 × 620 · fit 0.95 | 264 el · 832 × 796 · fit 0.93 |
| 40 | **172 el · 812 × 620 · fit 0.95** | 515 el · 1000 × 1332 · fit 0.68 |
| 120 | **172 el · 812 × 620 · fit 0.95** | 795 el · 1480 × 3892 · **fit 0.23** |

**The aggregated element count and the aggregated scene are byte-identical at 12, 40 and 120
spokes.** Aggregation turns an O(n) picture into an O(1) one. The performance ceiling then becomes
what it was always meant to be: a ceiling on *distinct* content, not on repetition — and at that
point 2,000 elements is a real number describing a real estate rather than a number that can never
be reached by the failure mode people actually hit.

Below the threshold the aggregated and un-aggregated pictures are the same picture. That is the
whole cost story: **at four spokes A2's canvas is A-schematic's, element for element** (192 against
191, and the one extra is an empty `<g>` that paints nothing). There is no regression to weigh
against the gain.

---

## 3. DECISION — like-kind sibling aggregation, at six

*margin tab: this closes `56` §12*

### 3.1 The rule

> **DECISION.** A set of **like-kind siblings** — same kind, same parent, same terminal, differing
> only by index — is drawn as one collapsed group when its cardinality exceeds **six**. The rule
> fires on the **sibling count**, never on the total element count, never on the zoom, and never on
> the viewport size.

It is a **transform on the model, run before layout**, not a special case inside the layout, the
router or the label placer. That is not an implementation note, it is the reason the design is
cheap: `A2-aggregated.html` adds aggregation to A-schematic without touching the layout engine, the
channel allocator, the crossing detector or the label placer, because all four simply receive a
smaller graph. Measured consequence: **zero edges cross a node box at 4, 12, 40 and 120 spokes,
aggregated and un-aggregated alike, and the crossing count stays at 5 in all eight cases** — the
router's behaviour is unchanged because the router was not changed.

### 3.2 Why six, and not eight

A2 chose eight; A3 and A4 chose six; round one's concept 03 chose eight (`58` §2.3). The number has
to be argued, and there is one argument that settles it and three that support it.

**The settling argument: `56` §5.4 already collapses a like-kind list at six.** Its edge vocabulary
table specifies, for an L2 trunk, the label `vlan 10, 20, 30` **or** `vlan 10–40 (14)` *above 6
VLANs*. That is already a named range plus a count, in the picture, replacing an enumerated
like-kind list, at a threshold of six, authored before this study existed. Choosing eight would
give the diagram two collapse thresholds for one behaviour and no reason for the difference.
**Choosing six makes it one rule.**

The three supporting arguments:

| | |
|---|---|
| **Geometry** | `56` §5.6 fixes `layer_pitch = 96 px` and `51` §14 fixes `--lh-micro: 1rem` = 16 px, which is the port lattice. `96 ÷ 16 = 6`. A like-kind group stacked on the port lattice is, above six, taller than one whole rank of the estate plus its routing channel — it stops being a feature of one node and becomes the dominant vertical dimension of the picture |
| **Perception** | One to four items are apprehended without counting; five and six by grouping; beyond that a reader counts serially, at which point a printed count is strictly better than the thing being counted, because `+40` is read in one fixation and forty boxes are not |
| **It is invisible on a small estate** | Measured: at four spokes the aggregated and un-aggregated pictures are identical. The reth pair (2 members, forever, one per chassis), the two chassis sub-rows, the three access switches and the two trunk ports on the SRX are all below six and are all left alone. A threshold that fires on those would be collapsing information the picture was giving away for free |

**A3's stated derivation is right and its attribution is wrong, and the correction matters.** The
file says *"`--pitch ÷ --portPitch = 96 ÷ 16 = 6` … Both numbers are already tokens, so the
threshold moves if the lattice moves and it cannot drift on its own."* There is no `--pitch` and no
`--portPitch` in `design/tokens.css` — the string `pitch` does not occur in the file at all — and
both values are JavaScript literals in the page. The derivation is real; the terms are `56` §5.6's
`layer_pitch` and `51` §14's `--lh-micro`. Written that way it is a corpus derivation, and it is
the form the implementation should read at runtime.

**Six is a constant, not a control.** All three variants expose it as a control on the page so the
owner can feel the number; that is right for a study and wrong for the product. A per-workspace
threshold is a setting whose only effect is to make two engineers' screenshots of the same estate
disagree, and `56` §3.6's whole argument about mental maps applies to it.

### 3.3 Where it fires

| Level | Collapses | Reads | Fires in the fixture at |
|---|---|---|---|
| **Unit** | `st0.0 … st0.39` on one device wall | `st0.0–39 · +40` | > 6 units on one wall |
| **Peer** | `SPOKE-01 … SPOKE-40` in the lateral column | `SPOKE-01–40` over `40 spokes` | > 6 like-kind peers |
| **Member** | LAG / reth members: `xe-0/0/2 … xe-0/0/25` | `ae0 · +24` inside each switch body | > 6 members |
| **Selector** | the conduit's own traffic selectors | `+40 selectors` on the conduit | with its unit group |
| **Port** | any side of any node whose port field exceeds six | same form as the unit level | > 6 ports on one side |

**Port level is included and it is not optional.** The unit case is the one `56` §12 names, but the
geometry argument in §3.2 is about a *port field*, not about tunnels — six is where any stacked
like-kind field on a device wall exceeds the layer pitch. A rule that fired on `st0.*` and not on
`ge-0/0/*` would be a special case for one kind, and `56` §12's whole complaint is that the
existing behaviour is a special case.

**The unit group and the peer group are one group with one state and two affordances.** `st0.0–39`
inside the hub and `SPOKE-01–40` in the lateral column are the same forty objects seen from two
ends — the 1:1:1 of unit, conduit and peer. Collapsing one and not the other would be a false
statement about the estate. All three variants got this right independently.

### 3.4 Where it must not fire

`reth0` has exactly two members forever, one per chassis, and **the two chassis are the meaning**.
It never reaches six and it therefore never collapses. That is the rule working, not a carve-out:
**aggregation fires on count, never on kind.** The same protects the chassis pair, the three access
switches and the two trunk ports. If a future estate genuinely has seven access switches, seven
access switches collapse, and that is correct — the seventh switch is not more interesting than the
sixth.

### 3.5 The mark — one form, three levels

The collapsed group is drawn as **the form it replaces, drawn three times, 4 px apart on the
lattice**: a stack. A device box becomes three nested outlines; a conduit closes with three caps
instead of one; a LAG bracket becomes three spines.

| | |
|---|---|
| **Why three and not two** | Two parallel outlines are already spent: `56` §5.2 G4 assigns two rails to LAG/reth members and two capped rails to a tunnel conduit. Three is unambiguously a stack |
| **Why not a dash, a dot, a fill or a hue** | G2 is spent product-wide — dashed is AI-proposed, dotted is pending (`51` §9) — and `55` §7.3 forbids a band that is fill-only because it vanishes under forced colours. The stack is stroked geometry and a text count, so it survives forced colours, monochrome print and greyscale by construction |
| **What it costs in the channel budget** | Nothing. It is a **repetition of an existing form**, not a new channel. `56` §5.2's table says nothing may be added to it without taking something away; the stack adds no row to it |
| **Its floor** | The 4 px separation falls under 3 device pixels and the outlines merge. Measured on A2, exactly: at zoom 0.75 the stack holds at 172 elements; at **0.74** it drops to 169 and the view band adds `aggregate stack merged`. It is announced, and it is still degradation. The count text must not degrade with it (§3.6) |

### 3.6 The affordance contract — what and how many

> **A collapsed affordance states WHAT it is hiding and HOW MANY there are, in the picture, always.
> A bare `+36` is a worse diagram than the texture it replaced, because the texture at least told
> you what it was made of.**

Measured, at 40 spokes, on the three variants — every drawn count label in the scene:

| | drawn in the picture |
|---|---|
| A2 | `st0.0–39 · +40` · `SPOKE-01–40` · `40 spokes` · `+40 selectors` · `ae0 · 2 members` |
| A3 | `st0.0–st0.39 · +40` · `SPOKE-01–SPOKE-40` · `40 spokes` · `+40 tunnels` · `ae0 · 2 members` |
| A4 | `st0.0–39 · +40` · `SPOKE-01–40` · `40 spokes ▸` · `40 tunnels` · `ae0 · 2 members` |

**No bare `+36` occurs in any state reachable in any of the three files.** Four different facts
happen to share the cardinality forty — forty logical units, forty peers, forty traffic selectors,
forty tunnels — and each is stated where it belongs rather than once in a badge.

**The count label is the one label in the picture that may not be demoted.** Every other label can
be counted out by `56` §5.5's collision search or dropped by `44` §4.7.2's LOD ladder. A count
cannot: **aggregate labels claim their boxes before anything else is placed, are exempt from the
LOD gate, and are drawn even if every candidate position collides.**

That rule is A4's, it is correct, and **only A4 implements it.** Measured, at 40 spokes, walking
every count label drawn in the scene as the zoom falls:

| zoom | A2 | A4 |
|---|---|---|
| 1.0 | 4 count labels | 4 count labels |
| 0.74 | 4 | 4 |
| 0.6 | 4 | 4 |
| **0.5** | **0** | 3 |
| 0.4 | 0 | 3 |
| 0.3 | 0 | 2 |
| 0.25 | 0 | 2 |

**A2's counts vanish entirely below zoom 0.6**, leaving a stack of three outlines with no number on
it. It is not *silent* — the view band still says `40 tunnels collapsed` — but the picture at that
zoom is exactly the bare mark this document's governing rule forbids, and 0.6 is not an exotic zoom:
it is the fit zoom of the un-aggregated forty-spoke estate. A4's labels survive to 0.25.

A2 found the same principle from the other direction and half-applied it: its collapsed LAG count
started as a midpoint label on the rail, could not find room in the 64 px gutter between the two
core switches, and was suppressed and merely *counted* as an unplaced label. **A count the placer is
allowed to drop is not an affordance.** It was moved inside each switch body, where placement cannot
fail — but it was never exempted from the LOD ladder, which is the same bug one layer down.

**Take A2's mechanism, A3's threshold, and A4's never-demoted rule.**

### 3.7 Expansion — windowed, and the reason is measured

> **DECISION — expansion is partial and windowed. The picture never offers "expand all" on an
> unbounded group.**

Activating a collapsed group draws a window of `threshold` members and leaves the remainder as a
**leading and a trailing residual**, each stating its own range and count and each itself
activatable — so the two residuals are a pair of page controls and a hundred and twenty spokes can
be walked six at a time. An expanded group states its own state inside the picture, in a reserved
band on the owning device: `st0 · 6 of 40 shown`.

The three variants implement three different models. Measured, by real `Enter` presses:

| | model | measured ladder |
|---|---|---|
| **A2** | windowed, anchored, with two residual page controls | at 120 spokes: 172 → **247** elements, `8 of 120 shown · 112 collapsed`, 3 tab stops. `Escape` → **172, exactly** |
| **A3** | incremental reveal, +5 per activation, terminating in *all shown* | at 40 spokes: 171 → 216 → 261 → 306 → 351 → 396 → 441 → **521** → 171 |
| **A4** | binary: one page of 12, or collapsed | at 40 spokes: 210 ↔ 330, on every activation |

**A3's ladder terminates in 521 elements at forty spokes — six more than the 515 it costs never to
aggregate at all.** Its seventh activation reconstructs precisely the texture the collapse existed
to remove, and it costs more than the un-aggregated form because the affordance machinery is still
in the tree. That is the argument for the windowed model, made by the file that did not take it.
A2's model cannot do this: there is no reachable state in which it draws more than a window plus
two residuals.

**One principled exception, and it is per group KIND, not global.** LAG members expand
all-or-nothing. An aggregate interface is a **bounded, unordered** set — a real `ae` is 2 to 16
members and the platform caps it
<!-- VERIFY: A2's thesis states Junos caps `ae` member count at 64. Not confirmed against Juniper
     documentation for any release, and the number is not load-bearing — the argument needs only
     that the set is bounded and unordered, which is true of any LAG. Confirm the figure or drop
     it before this sentence is quoted. --> —
so there is no page to walk and no ordering worth walking it in. The tunnel fan is unbounded and
ordered by spoke index. The window applies to the fan.

**The un-aggregated form is a separate control, not a per-group expansion.** `every one drawn` is
one click, it does not require expanding anything, and it is how the two forms are compared. It is
retained in the product, not only in the study: an engineer who does not believe the count is
entitled to see the forty.

### 3.8 The keyboard contract

This document binds no keys (ADR-0024, `53` is the sole owner of the keymap). What follows is the
ARIA disclosure pattern `54` §8, §13 and §17 already specify, applied to a group inside the SVG, and
it is a request against `53` rather than a binding.

| | |
|---|---|
| **Tab stops** | A collapsed group is **one tab stop per drawn terminal**. Measured at 40 spokes: A2 and A4 have 2 (one at the hub, one at the peer column); A3 has 1. **Two is right** — the same control drawn in two places is two places a keyboard user can reach it from, and the alternative is a control that is visible at one end of the picture and unreachable from the other |
| **Role and state** | `role="button"`, `tabindex="0"`, `aria-expanded` tracking the state, `aria-controls` naming the expanded content. Every drawing layer stays `aria-hidden` — the Outline is the keyboard and screen-reader interface (`55` §4.5) |
| **The accessible name carries the count** | Measured, verbatim, A2 at 40 spokes: `"st0 units 0 to 39, 40 tunnel interfaces collapsed on SRX-A. Activate to expand 8 of them."` and `"SPOKE-01 to SPOKE-40, 40 spoke peers collapsed. Activate to expand 8 of them."` |
| **Activate / collapse** | `Enter` and `Space` expand. `53` §2.2 gives Escape *"dismiss, cancel, unfocus"* as **one constant key**, and the three variants resolve that three ways. A3 and A4 bind Escape to the group element, so it only collapses the group that has focus; A3's document-level Escape handler dismisses the hover chip and nothing else, which makes its claim that *"Esc collapses from anywhere"* wrong. **A2 is right and should be copied**: one document-level handler with a stated priority ladder — the hover chip first, because it is the more transient thing on screen, then any expanded group — and a comment that says *"Escape never does both in one press."* That satisfies §2.2's one-key rule by **ordering** rather than by scoping, which is what a constant key needs |
| **Focus survives the rebuild** | Expansion re-runs layout and rebuilds the tree. Focus is re-homed onto the group's own affordance, not thrown to `<body>`. Measured on A2 and A4; both do it |
| **Partial state has no ARIA value** | At `6 of 40 shown` the correct attribute is `aria-expanded="true"`, and the accessible name must say *"partially expanded"* rather than *"collapsed"*. A3 says "Collapsed." in that state and announces `expanded … Collapsed.` This is a naming bug, not an attribute bug |
| **The Outline** | Every group is one Outline row carrying the same `aria-expanded` and the same count. `56` §7's bijection holds against the *drawn* tree |
| **Where the full list lives** | The inspector, which names **every** member. Verified at 120 spokes on A2: 120 rows, `SPOKE-01 / st0.0 / 203.0.113.10` through `SPOKE-120 / st0.119 / 203.0.113.129`. The picture states the count; the column states the names; both, always |

### 3.9 What the view band reports — G10, and a conflict with `52` §9.3

`56` §5.2 G10 is the release valve: anything the picture cannot say, the view band says. Measured,
at 40 spokes collapsed, all three variants lead with the same sentence:

```
diagram · 10 nodes · 15 edges · 40 tunnels collapsed
```

and when partly open:

```
8 of 40 tunnels shown · 32 collapsed
```

That is exactly right and it is the release valve doing the job it was written for. **But there is
a conflict with `52` §9.3 and it has to be resolved rather than absorbed.**

`52` §9.3 governs the shell's scent band and states three rules, one of which is **"no tab shows
more than two facts"**, and its table gives the diagram tab `12 nodes · L3`, or `aggregated` above
2,000 elements. The variants' strip is the *diagram's own header*, which carries eight or nine
facts. Both bands are real and `56` §5.2 G10 cites §9.3 as though they were one.

> **PROPOSED — `52` §9.3.** Distinguish the two bands explicitly. The **shell scent band** keeps its
> two-fact rule; its diagram tab reads `diagram · 12 nodes · 40 tunnels collapsed`, and the
> collapsed-state chip **replaces** the `aggregated` value in §9.3's table rather than being added
> after it — same slot, better content, still two facts. The layer mask moves into the diagram's own
> header, which is §9.3 rule 3's own escape (*"if a view needs three numbers to describe its state,
> the third belongs in that view's header"*). The **diagram's own header strip** is not governed by
> the two-fact rule and never was.

### 3.10 Never silently drop anything

Aggregated, at every size measured, the only suppressions any variant reports are counted:
`1 edge labels off`, `8 labels hidden`, plus the explicit `40 tunnels collapsed`. **The
un-aggregated comparison is where the honesty fails**, and it fails in the base, not in the
aggregation: at 120 spokes A3's un-aggregated view reports `band labels off`, `edge labels off`,
`ports collapsed`, `labels off`, `boxes and rails only`, `conduit collapsed`, `lag rails
collapsed`, `stubs below 6px` — **eight categories, not one of them carrying a number**. That is
A-schematic's LOD ladder, it is the picture aggregation exists to replace, and it is filed as a
defect in §6.2 because the un-aggregated form remains a shipped control.

### 3.11 The heterogeneity guard — the rule that is not built, and the fixture that hides it

This is the single largest gap in all three variants and it must be named at full strength.

**A collapsed group cannot currently say that one of its members is the exception.** If SPOKE-17 is
the one whose parse is eleven months old, or the one whose tunnel is bound to a different
interface, the collapsed box says `40 spokes` and nothing else. In the field, *"one of these forty
is not like the others"* is the single most common reason anyone opens a hub diagram.

**And the demo cannot show the failure.** Verified by reading the fixture generator in all three
files: every spoke is emitted by one loop with identical `age`, identical note and identical depth
text. There is no per-member variance in the model at all. **So the collapsed box is telling the
truth in this fixture only, and the variant would be adopted on evidence that structurally excludes
its worst case.**

> **The rule, specified here and built next (§7).** A group that is **not uniform** in the
> attributes the picture encodes — evidence age band (`56` §8), provenance origin, layer
> membership, and any attribute that changes a node's stroke or adds a second label line — **may not
> collapse silently**. It carries the exceptions *out* of the group and draws them individually
> beside the aggregate. Forty spokes of which one is stale draw as `SPOKE-01–40 · 39 spokes` plus
> `SPOKE-17` drawn on its own, in `--muted`, with its own age line. The count in the aggregate is
> then 39 and it is true.
>
> Uniformity is computed over a **declared** attribute set, not over every field. A group whose
> members differ only in their IP address is uniform for this purpose; a group whose members differ
> in whether they are stale is not. The attribute set is data, in the same register as `56` §3.4's
> rank table.

**Before this design is shown to the owner again, the fixture gets one down spoke and one stale
spoke.** That single change is worth more than any other work on these files, because it is the
only thing that makes the failure visible to the person deciding.

### 3.12 Closing `56` §12

`56` §12 carries, as *Open, not decided*:

> *"the second `TunnelInterface` unit problem. `BindsInterface` is `in: 0..1`, so `st0.0` holds one
> VPN. A hub with 40 spokes has `st0.0` through `st0.39`, and drawing 40 units on one device box is
> a texture. Candidate: collapse `st0.*` into one stub with a count and expand on drill-down, which
> is `44` §4.7.4's aggregation applied at the unit level. Needs a design pass and a hub fixture."*

> **`56` §12's open decision is closed as follows.** The candidate is taken and generalised: the
> collapse is not specific to `st0.*` and not an application of `44` §4.7.4 at all. It is an
> independent legibility ceiling (§2.4) that fires on like-kind sibling count at six (§3.1–3.2),
> applies at unit, peer, member, selector and port level (§3.3), renders as a stack with a named
> range and a count (§3.5–3.6), expands windowed with `aria-expanded` and the count in the
> accessible name (§3.7–3.8), and reports its state in the view band (§3.9). The hub fixture exists
> — `design/diagrams/*.html`, driven from four to a hundred and twenty spokes — **and it is not
> finished: it is uniform, and §3.11 is the part of the design pass it cannot yet demonstrate.**
> §12's entry is replaced by §3.11's, which is narrower and answerable.

### 3.13 Parallel edges between one pair of nodes — what fires today, and what it does instead

*margin tab: added 2026-08-08*

The owner described an estate this document did not model: *"2 boxes core and bridge with them
having 10 10g pipes"*, and, asked whether the ten were bundled into one logical interface or were
ten standalone links, answered **"they were standalone"** (recorded verbatim in `70` §10.1). That is
not the high-degree fan-out §3.3's Peer level was written for. It is **one pair of nodes joined ten
times**, and §§1–3.12 above do not address it anywhere.

**None of §3.3's five levels counts edges.** Unit, Peer, Member, Selector and Port all collapse
*nodes* — logical units, like-kind peers, member interfaces, traffic selectors, port stubs. The one
that looks like a counter-example is Member, and it is not: it collapses the member `Interface`s of
an `AggregateInterface` or a `RethInterface`, and the bundle those members belong to was **already
one drawn edge before the collapse**, because `56` §5.4 draws a LAG member set as two rails with a
bracket at both ends whatever its member count. Member level thins the inside of a device box. It
never reduces the number of lines between two boxes.

**What the model says, which is not what the picture draws.** The distinction matters because the
two are being asked different questions.

| | |
|---|---|
| **Ten standalone links, in the model** | Ten `Link` edges — `schema/schema.yaml` declares `edge: Link`, `from: [Interface]`, `to: [Interface]`, `out: "0..1"`, `in: "0..1"`, `symmetric: true` — one per interface pair. Under `19` §3.8's supersession the same estate is ten `Cable` nodes, each carrying two `Terminates` edges to `PhysicalPort`s, surfaced to the diagram as ten **derived** `Cabled` edges |
| **A bundle, in the model** | One `AggregateInterface` node plus ten `MemberOfAggregate` edges (`schema/schema.yaml`), drawn as **one** edge by `56` §5.4 |
| **What the owner's answer settles** | There is no `AggregateInterface` in this estate. **Nothing in the model groups the ten.** Any grouping in the picture is therefore a drawing decision and has to be labelled as one — it may not be drawn in a form that asserts a bundle |
| **The one model-level grouping the schema does carry** | `Cable.assembly` — *"The grouping id deliberately shared — breakout assembly, multi-fibre bundle. Excluded from identity; grouping is a query, not a key."* It records that several runs travel together (`19` §3.4's breakout case: one QSFP cage, four lanes, four cables). It does not make them one interface |

**What the picture does today is worse than "nothing fires".** Take the owner's estate and walk
§3.3's table over it:

| Level | Fires? | Consequence |
|---|---|---|
| Port | **Yes, at both ends.** Ten ports on one side exceeds six | Each device's port field collapses to one stack with a count (§3.5) |
| Peer | **No.** There is exactly one peer — the bridge — not seven | The far box is drawn as itself, correctly |
| Unit, Member, Selector | No | — |
| The ten edges | **Nothing.** No level counts them | Ten lines are routed between the two boxes |

> **THE FINDING. The two ends collapse and the ten edges do not, so the picture draws ten lines
> terminating on a stack that draws one stub. That is not a legibility problem, it is a
> contradiction: §3.3's own rule is that a group is "one group with one state and two affordances",
> and here both ends of the group are collapsed while the thing between them is drawn ten times.**

Two channel facts bound any fix, and both are already spent:

- **`56` §5.2 G4 owns the two-rail form.** Its three values are 1 / 2 separate / 2 capped = simple
  link / aggregate-or-reth members / tunnel conduit. **A collapsed parallel-edge group drawn with
  two rails would assert a LAG that does not exist** — the exact claim the owner's clarification
  rules out. §3.5 already reached the same conclusion for the node-level mark and took three.
- **`56` §5.2 G5 owns the terminal.** Its three values are port stub / bracket both ends / bracket
  one end = plain link / LAG / reth. **The stub is what says *standalone*,** so a collapse must keep
  it. A bracket at both ends means the members were aggregated, which is a statement about the
  device's configuration and not about the drawing.

**One gap this exercise exposes that is wider than the rule.** `56` §4.1's projection table predates
`19`'s physical model. `19` §3.8 states that *"`56` §5.4's edge vocabulary and `56` §4.1's `Link edge
→ line` row keep working, against a derived edge instead of an asserted one"* — true, and the table
has not been amended to say so. Grepped for this document, 2026-08-08: the strings `Cable`,
`PhysicalPort`, `PassiveNode`, `Premises` and `Terminates` do not occur anywhere in `56` (`Cabled`
occurs once, in §6.4), and none of them occurs in this document either. **The document that owns the
diagram has no row for the kind that now carries a physical run.** Filed in §9; it is `56`'s to
answer.

### 3.14 PROPOSED — the sixth level: parallel edges, one drawn edge, one visible count

*margin tab: proposed to `56`, not decided here*

> **PROPOSED — a sixth aggregation level, `Link`, on the same counter and the same constant.** Two
> nodes joined by more than **six** edges that are **indistinguishable in every channel `56` §5.2
> allocates** are drawn as **one edge carrying a visible count**, expandable. It is counted in
> edges, never in elements and never in ports. The threshold is §3.1's six and the counter is §7.2
> X1's `sibling_group_max`; §9 already refuses a second number until there is evidence for one.
>
> Like every other level it is a **transform on the model, run before layout** (§3.1). The router,
> the channel allocator and the label placer receive one edge and are not modified.

#### 3.14.1 The mark

| | |
|---|---|
| **Form** | §3.5's stack, applied to an edge: **three rails**, the form it replaces drawn three times. Not two — G4 owns two, and two would say LAG |
| **Terminals** | **Port stubs at both ends, never brackets.** G5's stub is the channel that says the members are standalone (§3.13). No caps either: G4's capped pair is the tunnel conduit |
| **Label** | A named range at each end **plus** the count, per §3.6's affordance contract: `xe-0/0/0–9 ↔ xe-1/0/0–9 · 10 links`. **Never a bare `+10`** — §3.6's governing rule is that a collapse states *what* it is hiding and *how many*, and an edge collapse hides two port ranges, not one |
| **The count is never suppressed** | It claims its box before anything else is placed, is exempt from `44` §4.7.2's LOD gate, and is drawn even if every candidate position collides. That is A4's never-demoted rule (§3.6), and X9 asserts it down to zoom 0.25. `59` §6.2 files the defect where counts vanish at scale; a new mark must not inherit it |
| **The accessible name** | Carries the cardinal and both ranges, in §3.8's form: *"xe-0/0/0 to xe-0/0/9 on CORE-01, 10 standalone links to BRIDGE-01. Activate to expand 6 of them."* The word **standalone** is load-bearing and is not decoration |
| **The rail gap** | **Not set here.** `56` §5.3 owns `--dg-stroke`, `--dg-rail-gap` (3 px) and `--dg-conduit-gap` (5 px), and this document binds no token. The constraint is stated instead: at the LOD floor a three-rail stack must not converge on either. §3.5 measured the node-level stack merging at zoom 0.74; the edge-level analogue has not been measured and must be, against a real render, before the value is chosen. Request against `56` §5.3 |

#### 3.14.2 The grouping key — what may share one drawn edge

> **PROPOSED — two parallel edges group only when every allocated channel would render them
> identically.** G4 rail count, G5 terminal, G6 mid-tick, G9 arrowhead, the `--muted` stroke and
> `inferred` tab that `11` §7.6 gives derived edges, and the drawn form `56` §5.4 assigns. **Any
> channel that differs splits the group.** Mixed kinds between the same pair therefore group by
> kind, one drawn edge per group, each with its own count.

This is not a second rule. It is **§3.11's heterogeneity guard applied to edges**, with the channel
budget standing in for §3.11's *"declared attribute set"* — which is the right declared set for an
edge, because the channels are exactly what the picture claims about it. Three consequences:

- A pair joined by six standalone links, one `ae0` LAG and one tunnel draws **three** edges with
  three counts, never one edge reading `8 links`.
- A group of one is drawn as itself. There is no `1 link`.
- A mix of asserted `Link` edges and derived `Cabled` edges between the same pair splits, because
  `11` §7.6 renders derived edges in `--muted` with an `inferred` tab and that is a channel
  difference. If one of the ten is stale or inferred, it is carried out of the group and drawn
  beside it, and the aggregate then reads `9 links` and is true (§3.11).

#### 3.14.3 What happens at 2, at 10, and at 100

| n | What is drawn | Why |
|---|---|---|
| **2** | Two lines, two pairs of port stubs, both labels. **Nothing fires** | Two is below six. Two links between one pair is a redundancy fact the picture gives away for free, and §3.4's argument for the reth pair is the same argument: aggregation fires on count, never on kind, and a threshold that fired here would be collapsing information that cost nothing to draw |
| **10** | One three-rail edge, port stubs at both ends, `xe-0/0/0–9 ↔ xe-1/0/0–9 · 10 links`. The two port fields are already collapsed by §3.3's Port level, and they collapse **with** this group rather than independently | Above six. This is the owner's estate. Element cost falls to §2.5's O(1) shape for the ten lines and their twenty stubs |
| **100** | **The same drawing.** The count reads `100 links`; the range reads the real first and last port names. Element cost is the 10 case's | This is what X3 asserts for nodes, applied to edges. A hundred parallel runs is a real shape in a data-centre fabric, and the picture must not be a function of it |

#### 3.14.4 One state, three affordances

§3.3 states the rule for the unit group and the peer group: *"one group with one state and two
affordances."* A parallel-edge group has **three** — the near port stack, the drawn edge, and the far
port stack — because the edge itself is drawn and is reachable. Expanding any one expands all three;
collapsing any one collapses all three. Failure mode 7 is the same failure, one shape further on: a
picture that says ten at the core, ten at the bridge and draws six lines is describing an estate that
does not exist.

#### 3.14.5 Expansion

§3.7's windowed model, unchanged. Parallel links between one pair are **unbounded and ordered by
port index** — the same shape as the spoke fan, not the shape of an `ae`, which §3.7 exempts because
it is bounded and unordered. At 100: `6 of 100 shown · 94 collapsed`, with a leading and a trailing
residual, each stating its own range and count. X6 binds unchanged: **no reachable state may draw
more elements than the un-aggregated form**, which is the measured failure §3.7 records against A3.

#### 3.14.6 What this proposal deliberately does not do

- **It adds no channel.** The three-rail stack is a repetition of an existing form (§3.5), and the
  expansion state is G10 at the element, per §9's existing recommendation. `56` §5.2's table gains
  no row.
- **It does not decide the heterogeneous fan.** Ten neighbours of ten different kinds — `70` §10.1's
  other hole — is a different shape with none of the same remedy, and §3.14.2's key deliberately
  refuses to group it. It stays open in `70` §13.
- **It does not say how a `Cable` is drawn.** §3.13's last paragraph; that is `56` §4.1's to answer.
- **It never asserts a bundle.** If an operator wants ten runs treated as one interface, the model
  already has the word for it and the word is `AggregateInterface`. A drawing that says it on the
  model's behalf is the failure this whole section exists to prevent.

---

## 4. DECISION — no colour

*margin tab: the models were built; this is the answer*

### 4.1 The decision

> **DECISION — the diagram takes no colour. `56` §5.1 stands unamended: not "colour used
> sparingly" — none. Neither A3's overlay tier nor A4's always-on zone colour is adopted.**
>
> **If this is ever reversed, it is reversed to A3's overlay architecture and never to A4's
> always-on model.** §4.7 states the gate. §5 records the palette, measured, marked as proposed and
> not adopted, so that reversing costs a decision rather than a rebuild.

### 4.2 The four arguments, in order of weight

**1. Aggregation removed the reason to want colour, and colour could never have supplied it.**

The forty-spoke picture was illegible because of *repetition*, not because of undifferentiated
structure. Forty identical things get forty identical colours. Any hue scale applied to the fan is
forty of the same hue; any hue scale applied to the interesting content — the zones, the VLAN
bracket, the cluster pair, the routing instance, the access layer — is applied to content that has
been squeezed into the lower-left corner at fit zoom 0.68 and cannot be read at all. **Colour
cannot fix a repetition problem.** Aggregation can, does, and does it without spending a channel:
172 elements, 812 × 620, fit 0.95, identically at 12, 40 and 120 spokes.

The corollary is the one that decides this section: **the colour models were never competing
against A-schematic. They were competing against A2.** With the texture gone, the monochrome
picture is already legible at 120 spokes, and the question colour has to answer became narrow —
*with the repetition already removed, what distinction is still hard to make?*

**2. Every distinction the three models colour is already drawn, and drawn with a word.**

`56` §5.2 G7 gives band form three values: vertical bracket = zone, horizontal bracket = VLAN,
closed box = routing instance. `56` §5.5 (M38) requires the band label to carry the kind: a zone
band reads `zone WAN`, a VLAN band reads `vlan 10`, an instance box reads `ri CUST-A`. Every one of
A3's five overlays and the whole of A4's palette classifies over exactly those partitions.

A4 proves this against itself, in its own strongest paragraph. It found that zone VPN owns the
`st0` units inside the SRX *and* every peer those units reach, which live in different columns, so
one band cannot enclose both — the set is discontiguous. Its conclusion is correct: *"a design that
leaned on the band as the non-chromatic carrier would have a hole in it precisely where zones get
interesting,"* so it prints a per-node zone tag. But once the tag is printed on every node, the hue
is a **speed-up of something already legible**. A4 says so in terms: *"It buys speed, not
information."*

**3. Fathom has no live state, and live state is what colour encodes in every tool that
demonstrably makes it pay.**

The research found that every verifiable colour use in the real tools studied encodes something
Fathom does not have and will never have: link up/down, utilisation, health, alarm state. Fathom
**never touches a network device** (invariant 2, a permanent product boundary), `11` §6.9 keeps
runtime state out of the graph, and `56` §1.3 puts *"runtime state of any kind: SA indices, tunnel
up/down, interface counters, learned routes"* explicitly out of scope. So the use of colour that
justifies its cost in those tools is structurally unavailable here.

What remains is nominal partitions — zone, VLAN, routing instance, layer — which is the weakest
thing colour does, and which G7 and the band labels already do. **`56` §5.1's stated reason for no
colour is the risk reservation. That is a real reason and it is the weaker one. The stronger reason
is that this product has nothing for colour to say that the words do not already say**, and §11
proposes adding it to §5.1.

**4. The reservation's value is its scarcity, and that is spent by any second palette.**

`55` §3.5 counts eleven axes the product renders and exactly one of them uses colour. That
scarcity is what makes `READ-ONLY — SAFE ON PRODUCTION` / `CHANGES CONFIG — NEEDS A COMMIT` /
`DISRUPTIVE — DROPS LIVE TRAFFIC` learnable once and trusted forever. Neither model breaks the
reservation semantically — measured, no introduced hue comes within 44° of a reserved hue (§5.3) —
but A4 names the real cost precisely and honestly:

> *"Beside a monochrome diagram the risk legend was the only colour on the page and therefore
> self-evidently the most important thing on it. Beside a coloured diagram it is still the most
> salient thing, but it now reads as one of several colour systems rather than as the colour
> system — the reservation is defended semantically and diluted rhetorically."*

That is correct, and it is paid on every screen, permanently, whether or not the reader cares about
zones today.

### 4.3 What is lost by not taking the overlay tier — named, not softened

A3 is the better of the two colour models by a wide margin and it is not adopted. What that costs:

| Lost | Detail |
|---|---|
| **The one-glance answer to one real question** | *"Is anything in the wrong zone?"* Three seconds of scanning stays three seconds. That is a real purchase and it is refused |
| **A verified-safe architecture, ready to build** | Monochrome base, user-selected overlay, key **generated by the choice** and destroyed with it, colour a pure function of the graph (sorted class words mapped to slots in order), so there is no `node.color` and no inherited map whose colours mean whatever the last engineer chose. That last property is the failure the research found in Apstra, and A3 does not have it |
| **A genuinely good invariant** | *Nothing is tinted that is not also tagged.* If the class word will not fit, the element keeps its neutral stroke and the refusal is **counted** in the view band. That is the direct answer to both failures the research found — Meraki's blue diamond, identical in shape to its unknown-device diamond, dying in greyscale; netlab's four BGP session types at identical stroke width and identical arrowheads separated by hue alone. Neither is reproducible under A3's rule, because the tint would simply not have been applied |
| **The verification overlay specifically** | The only overlay that is fully redundant with an existing channel (G1 tone, G8 age line, and the unverified rule), so it can be wrong about nothing |

Two things A3 does not lose that are worth recording as *not* reasons to refuse it: its hue
separation and its contrast are measured and clean (§5.3, §5.4), and `design/tokens.css` is
untouched.

**What A3 costs, and why it loses to none rather than to A4.** It adds a channel — its own tag
carrier — and `56` §5.2's table is explicit that *"nothing may be added to it without taking
something away."* A3 took nothing away. Its VLAN overlay is structurally incomplete and says so:
VLAN membership is a **set**, not a partition, so a per-VLAN colouring is not expressible at all,
and 2 of its 6 VLAN-bearing elements go untinted at every size because the tag will not fit. And
its expansion ladder terminates in 521 elements at forty spokes (§3.7), which is more than never
aggregating.

### 4.4 What is lost by not taking always-on zone colour

| Lost | Detail |
|---|---|
| **The partition legible before a label is read** | In the monochrome picture the only grouping visible at a glance is rank — what is above what |
| **Two genuinely interesting facts made loud** | In the fixture the SRX is the only neutral box in a coloured picture *because it is the boundary*, and exactly two edges change tone *because exactly two cross a boundary*. Both were already true in A-schematic and both were invisible |
| **A4's best idea** | That a boundary device is **computed, not declared** — any node whose terminals span two or more zones is in no zone, because it is the thing that defines them. §4.6 salvages this |

### 4.5 The measured cost of always-on, which is why it loses to the overlay and not only to none

All measured at 40 spokes, aggregated, same estate, one toggle:

| Cost | Measurement |
|---|---|
| **Elements** | 210 against A2's 172 for the same aggregated estate |
| **Scene width** | 976 px against A2's 812 |
| **The zone tag alone** | zone tags on: 210 el, 976 × 636. zone tags off: 195 el, 816 × 636. **160 px, 19.6% of the drawing's width, spent on the tag.** Toggling colour itself off changes nothing: 210 el, 976 × 636. The hue is free; the carrier that makes the hue legal is what costs |
| **The age line, which the file says outranks zone** | A4 §3 states *"Evidence age outranks zone."* In the render the tag's width is subtracted from the budget the age line is truncated against, and the tag is never truncated. With tags on, four age lines truncate — `parsed 4 m…`, `parsed 11 mont…`, `last parsed 20…`. With tags off they read in full. **The stated precedence is inverted in the code, and the reader loses the actual parse date on every stale node** |
| **The greyscale ramp collides with G1** | A4's non-chromatic carrier is a luminance ramp: measured greyscale bytes **47 · 58 · 69 · 80 · 92**. `--muted` is **101**. **UNTRUST sits Δ9 from `--muted`**, at the same 2 px stroke weight, on the same fill. In dark theme it is Δ6 (153 against 147). `--muted` is the de-emphasis tone — `56` §8's stale and unverified boundary, and inferred edges. The file asserts the opposite twice, including in the PROPOSAL block offered for adoption into `51` §14: *"no zone hue can be read as ink or as de-emphasis when the colour is gone."* **That sentence is measurably false**, and the consequence is a regression: A-schematic's real-versus-inferred edge distinction is grey 23 against grey 101, Δ78; A4's UNTRUST-versus-inferred is grey 92 against 101, Δ9 |
| **The forced-colours fallback fails in the dark theme** | §5.6 |
| **The channel is spent permanently** | Once zone owns hue, hue can never mean blast radius, change-set membership, or *"the six devices this command is about to touch"* — which is close to Fathom's actual purpose. A4 names this itself as *"a one-way door"* |

**The greyscale finding is the deep one and it generalises.** A4's design decision — make value the
non-chromatic carrier by ordering the ramp — is precisely what walks it into `56` §5.2's G1, which
already spends tone on freshness. A3's opposite decision — near-isoluminant hues, measured
greyscale bytes 64–74, a spread of ten — keeps the whole palette 27 greys away from `--muted` and 41
from `--ink`, and puts the entire carrying load on the drawn word. **A3's choice is the correct one
and A4's is not, and the reason is a corpus constraint neither file cites: G1 already owns tone.**
Any future colour proposal must be near-isoluminant, for that reason, and §5.7 records it as a rule.

### 4.6 What to salvage from A4 with no hue at all

Two of A4's ideas are drawing rules rather than colour rules and both survive the decision:

1. **The boundary device is computed and printed.** Any node whose terminals span two or more zones
   prints `BOUNDARY` in the margin-tab register. It costs one word, no channel, and it is a fact
   the picture currently does not state. **Recommended.**
2. **A terminal carries the zone of its own interface, not of the box it lands on.** On a firewall
   those differ and *that difference is the firewall*: `reth0` is WAN, `fxp0` is MGMT, `ge-0/0/4–5`
   are TRUST, `st0.*` are VPN. This is `56` §5.5's port stub doing more work, not a new channel.
   **Recommended, and it inherits the LOD ladder rather than being exempt from it** — measured on
   A4, all ten zone words survive from zoom 1.0 down to 0.4 and are gone at 0.3, which is below
   `44` §4.7.2's 0.35 threshold where node labels go too. That is the correct behaviour: a word
   nobody can read is not a carrier.

**One thing not to salvage: A4's VPN band encloses the SRX.** Measured in scene coordinates at
40 spokes: the VPN band spans x 129–321, y 177–329; the SRX box, whose own class is `dg-box
boundary` and whose printed tag reads `BOUNDARY`, spans x 144–304, y 192–312. **The band strictly
contains it on all four sides.** On the single node the variant advertises as its best insight,
enclosure says VPN and the text says BOUNDARY. If the boundary device is in no zone, no zone band
may enclose it.

### 4.7 The gate — what would reverse this

Not a hedge. These are the conditions under which §4.1 is wrong, written now so that reversing is a
decision and not a mood:

| # | Trigger | Why it is the right trigger |
|---|---|---|
| G1 | **A pilot engineer, unprompted, asks a question the picture cannot answer at a glance and which is a partition of drawn elements.** Recorded verbatim, twice, from two people | It is the only evidence that hue buys a real second of a real person's time. Nothing in this study is that evidence |
| G2 | **A sixth thing appears that needs a channel and there is no geometry left.** `56` §5.2's budget is ten channels and §4.7 already refuses a sixth layer | A budget that is genuinely full is the honest reason to spend a new one |
| G3 | **The heterogeneity guard (§3.11) ships and proves insufficient** — i.e. exceptions carried out of a group are found in testing to be missed at a glance | This is the most likely real trigger, and note that its answer is probably *weight or position*, not hue |

If any of the three fires: adopt **the overlay tier**, default off, key generated by the choice,
invariant *nothing tinted that is not also tagged*, near-isoluminant palette (§4.5), from the block
in §5. Do not adopt an always-on model, ever, for the reasons in §4.5.

---

## 5. The palette, measured and shelved

*margin tab: PROPOSED — not adopted*

### 5.1 Why this section exists at all

Two hours of measurement produced a palette that is provably clear of the reservation and provably
survives greyscale. Throwing that away would mean re-deriving it under time pressure the day G1
fires. It is recorded here, with every number, marked at every heading as **not adopted**, so that
the decision to spend the channel is a decision and not a rebuild.

> **NOTHING IN THIS SECTION IS IN FORCE. `design/tokens.css` is a verified transcription of `51`
> §14 and is not edited by this document. If this is ever adopted, the values move into `51` §14
> first and the transcription is regenerated from it — never the reverse.**

### 5.2 The block

Taken from `A3-overlay-colour.html`, which is the architecture §4.7 would reverse to. Five slots,
assigned deterministically from the sorted distinct class words of the selected overlay, so the same
estate produces the same colours in every session on every machine.

```css
/* PROPOSED addition to 51 §14 — NOT YET ADOPTED. See 59 §5.
   Overlay tier only. Stroke colour only — fill is never tinted, because the
   three-step tonal ladder (--surface-2 canvas / --surface region / --page box)
   is the base drawing's largest legibility win and the overlay does not get to
   spend it. Deleting this block returns the diagram to a strictly-token file. */
:root {
  --ov-1: #0A5877;   /* 197.1° */
  --ov-2: #14508C;   /* 210.0° */
  --ov-3: #2F3D96;   /* 231.8° */
  --ov-4: #57339B;   /* 260.8° */
  --ov-5: #7E2A72;   /* 308.6° */
}
:root[data-theme="dark"], :root:not([data-theme="light"]) {  /* under prefers-color-scheme: dark */
  --ov-1: #58AEC9;  --ov-2: #6FA9EA;  --ov-3: #8D9BF1;
  --ov-4: #B292EC;  --ov-5: #D98BC9;
}
```

Note the selector on the dark block. **A4's forced-colours fallback fails because it got this
wrong** (§5.6); any adoption must use a selector at least as specific as the dark override it has to
beat.

### 5.3 Hue separation from the reserved trio — measured

HSL hue angles computed from the resolved token values, not asserted:

| | light | dark |
|---|---|---|
| `--safe` | **152.2°** | 152.0° |
| `--caution` | **25.5°** | 25.4° |
| `--danger` | **0.0°** | 0.9° |
| `--ov-1` | 197.1° | 194.3° |
| `--ov-2` | 210.0° | 211.7° |
| `--ov-3` | 231.8° | 231.6° |
| `--ov-4` | 260.8° | 261.3° |
| `--ov-5` | 308.6° | 312.3° |

**Closest approach of any proposed hue to any reserved hue: `--ov-1` to `--safe`, 44.9° in light,
42.3° in dark.** For scale, the product already relies on **25.5°** of separation between
`--caution` and `--danger`, so the proposed margin is wider than the reserved trio gives itself.
Every proposed hue is cyan, azure, indigo, violet or magenta. None is in the green, amber or red
family.

For completeness, A4's zone palette measured on the same basis: 272.2° / 251.4° / 227.6° / 207.9° /
197.8°, closest approach `--z-untrust` to `--safe` at **45.6°**. A4's own figure of 48° is measured
to a stated green-family boundary of 150° rather than hue-to-hue; both are defensible and neither is
a collision. **Hue separation is not why A4 loses.**

### 5.4 Contrast against `--page`, both themes — measured

WCAG 2.x relative luminance. `--page` is `#FFFFFF` light, `#0F1215` dark.

| | on light `--page` | on dark `--page` |
|---|---|---|
| `--ov-1` | **7.85** | 7.44 |
| `--ov-2` | **8.22** | 7.64 |
| `--ov-3` | **9.42** | 7.24 |
| `--ov-4` | **8.93** | 7.35 |
| `--ov-5` | **8.53** | 7.59 |

For reference, from `51` §3.4 and §5.5 and reproduced here: `--ink` 17.99 / 14.67, `--muted` 5.77 /
6.16, `--hairline` 1.45 / 1.43. Every proposed value clears WCAG AA (4.5:1) with room, and clears
AAA (7:1) in both themes — which in this product only `--ink` and `--danger` otherwise do. As a
stroke on a node boundary the applicable criterion is 1.4.11 (non-text, 3:1) and the margin is
large.

### 5.5 Greyscale survival, distinction by distinction

Rendered by Chromium with `filter: grayscale(1)`, decoded from the PNG and sampled:

| | greyscale byte |
|---|---|
| `--ink` | **23** |
| `--ov-3` | 64 |
| `--ov-5` | 65 |
| `--ov-4` | 66 |
| `--ov-2` | 72 |
| `--ov-1` | 74 |
| `--muted` | **101** |
| `--hairline` | 214 |
| `--surface` | 244 |

The five collapse to a ten-byte spread — effectively one grey. **That is the design, not an
oversight.** G1 already spends tone on freshness; a palette with a lightness ladder competes with
the channel that says whether the box can be trusted, which is exactly the collision §4.5 measures
in A4. The whole palette sits **27 greys clear of `--muted` and 41 clear of `--ink`**, so no tinted
stroke can be misread as either.

Hue therefore carries nothing on its own, and the redundancy has to be complete. Distinction by
distinction, this is what carries each one when the hue is gone:

| Overlay | Distinction | Non-chromatic carrier |
|---|---|---|
| zone | TRUST / WAN / VPN | The zone name drawn inside every tinted box, **plus** G7's vertical bracket the box sits inside, **plus** the band label `zone WAN` |
| layer | physical / L2 / L3 / security / overlay | A three-character tag on every tinted rail, **plus** `56` §5.4's edge vocabulary, which already separates these losslessly in form: a conduit is two capped rails, a trunk carries two mid-ticks, a route carries an open V |
| verification | fresh / ageing / stale / unverified | The state word inside the box, **plus** G8's age line, **plus** the 1 px rule under an unverified box. This is the one overlay that *overwrites* an existing channel — tinting the boundary spends G1's tone — and the word is what makes it safe |
| routing instance | `CUST-A` / `inet.0` | The instance name inside the box, **plus** G7's closed box around the non-default instance |
| VLAN | a VLAN set | The set **is** the edge's own label, and G6's mid-ticks already separate trunk from access. Structurally incomplete: VLAN membership is a set, not a partition, so per-VLAN colouring is not expressible at all |
| **absence** | classified by nothing | Neutral stroke, no tag, and **its own counted row in the generated key**. A legend that omits its most common value is the Meraki defect in a different costume |

### 5.6 Forced colours, and the two bugs the models found

`51` §6 and `55` §7.3 govern. Two findings, both measured, both real regardless of the palette
decision.

**Bug 1 — A4's forced-colours fallback does not apply in the dark theme.** A4 declares
`@media (forced-colors: active) { :root { --z-trust: CanvasText; … } }`. Measured resolved values on
the document element:

| `forced-colors` | scheme | `--z-wan` resolves to |
|---|---|---|
| active | light | `CanvasText` — correct |
| **active** | **dark** | **`#6BAFF6`** — the dark zone hue, not the system colour |
| none | light | `#0E5CA0` |
| none | dark | `#6BAFF6` |

The cause is specificity: the fallback is `:root` at (0,1,0) and the dark override is
`:root:not([data-theme="light"])` at (0,2,0), so the dark override wins inside the forced-colours
block. **Windows High Contrast Black is the default high-contrast theme**, so this is the common
case, not the corner. A4 reports this area as *"measured, not asserted"*; it was measured on
`getComputedStyle` in the light theme only.

**Bug 2 — A3's tints do not return to the system palette either, and the claim that they do is
wrong.** A3 states *"under `forced-colors: active` the tints return `forced-color-adjust: auto` and
the system palette wins."* Measured, zone overlay on, sampling every `.dg-box`, `.dg-peer` and
`.dg-band` in the scene under `forced-colors: active`: **8 of 18 stroked elements keep their `--ov`
hue**, and the remaining 10 carry `forced-color-adjust: none`, inherited from A-schematic. The tag
text and the ribbon are returned to the UA; the stroke is not.

**And the base is why.** A-schematic declares:

```css
@media (forced-colors: active) {
  .dg-region, .dg-box, .dg-peer, .dg-edge, .dg-band { forced-color-adjust: none; }
}
```

A2 inherits it and extends it to the stack. A3 inherits it. That directly contradicts two documents:
`55` §7.3 specifies `.dg-node { forced-color-adjust: auto; }` — *let the UA win* — and `51` §6 states
that *"`forced-color-adjust: none` appears exactly once in the product, on the egress band, because
that is the one element whose meaning is its inversion. Everywhere else the user's palette wins."*
**A4 is the only one of the four that gets this right**, and it then broke it a different way. Filed
in §6.1.

### 5.7 Rules any adoption must carry

1. **Overlay only. Default off. Key generated by the choice and destroyed with it.**
2. **Nothing is tinted that is not also tagged.** Enforced in the renderer, asserted in the test
   harness, and refusals counted in the view band. Not a guideline.
3. **Near-isoluminant.** Measured spread of the whole palette ≤ 15 greyscale bytes, and ≥ 20 clear of
   both `--ink` and `--muted` in both themes. G1 owns tone (§4.5).
4. **Stroke only.** Fill is never tinted; the `--surface-2` / `--surface` / `--page` ladder is not
   the overlay's to spend.
5. **Colour is a pure function of the graph.** Sorted class words → slots, in order. No `node.color`
   — `56` §0's governing rule forbids it.
6. **`forced-color-adjust: auto`, with a fallback selector at least as specific as the dark
   override** (§5.6), and the render verified by looking at pixels on a real high-contrast desktop,
   not at computed styles.
7. **Absence is a value and gets a counted row in the key.**
8. **`55` §3.4's monochrome test is extended to the diagram** with the Outline standing in for the
   accessible name, and it fails the build.
9. **Dash and dot stay spent.** `--rule-style-proposed` and `--rule-style-pending` are untouched
   (G2, `51` §9).

---

## 6. What the variants found in the base that has to be fixed regardless

These are defects in `A-schematic.html`, and therefore in the design it encodes. They are
independent of both decisions above.

| # | Defect | Evidence | Fix |
|---|---|---|---|
| 6.1 | **`forced-color-adjust: none` on five diagram classes** | §5.6. Contradicts `51` §6 (*"exactly once in the product"*) and `55` §7.3 (*"let the UA win"*) | Remove it. A stale node's tone step already has its documented fallback — `55` §7.3 forces the age line on at every zoom under forced colours. That mechanism is the answer and it is already specified |
| 6.2 | **Counts are dropped from the suppression list at scale** | §2.2. At 40 spokes `41 edge labels off`; at 64, `edge labels off` — no number — plus four more uncounted categories. At 120, A3's un-aggregated view reports eight uncounted categories | `56` §5.5 requires counted, never dropped. Add a counter asserting every suppression chip carries a cardinal, and assert it at the top of the range, not the bottom |
| 6.3 | **`56` §5.6's width formula ignores labels set inside the device body** | A2's finding. It never bit at `st0.39` (6 characters); `st0.0–119 · +120` is sixteen and runs out through the wall | The formula must take `max(outside label, inside label field)`. `56` §5.6 needs the amendment whether or not aggregation ships |
| 6.4 | **An inside label always anchors right** | A2's finding. Correct for a right wall, wrong for anything terminating on a left wall — the label lands at the far side of the box from its own port | Anchor to the label's own side |
| 6.5 | **A plain box starts its side-port field inside the header band** | A2's finding. Invisible while side ports were bare stubs; an instant collision with the device name the moment one carries text | A box with any inside label starts its field below the header |
| 6.6 | **Crossing detection is O(n²) over segments with no prefilter** | A2's finding: at 120 spokes roughly 1.3 million segment-pair tests. An axis-aligned bounding box per routed edge makes it exact and cheap | Prefilter. Two edges whose boxes are disjoint cannot cross, so nothing is missed |
| 6.7 | **The `ae0 · 2 members` plate laps both core node borders** | Present at every spoke count in every variant. The placer's collision test uses the text extent; the plate is drawn with padding around it | Test the plate, not the text |
| 6.8 | **Plural agreement in the view band** | `1 channels · 5 crossings`, `1 edge labels off` — on the default screen, in all variants | Ten-minute fix on the exact strip being judged |
| 6.9 | **A latent range bug in the collapsed LAG name** | `A2-aggregated.html`: `nameRange: lag.members[0] + '–' + lag.members[M - 1].slice(-1)` takes the last *character*, so members `xe-0/0/2 … xe-0/0/25` produce `xe-0/0/2–5`. Verified never rendered today — the edge inspector emits no `range` row — and the accessible name uses the correct first and last | Fix before something renders it. A range string that silently lies is worse than no range string |

---

## 7. What to build next

*margin tab: concretely*

### 7.1 The slice

Ordered. Each item is a day to a few days, and each one is finishable.

| # | Work | Why first |
|---|---|---|
| **1** | **Add one down spoke and one stale spoke to the hub fixture.** One `age: 'stale'` with a real `ageLine`, one bound to a different interface | §3.11. Until this exists, nobody — builder, reviewer or owner — can see the aggregation's worst case, and the design would be adopted on evidence that excludes it. **This is worth more than every other item on the list** |
| **2** | **Build the heterogeneity guard** against that fixture: uniformity computed over a declared attribute set; exceptions carried out of the group and drawn individually; the aggregate's count reduced accordingly | §3.11. It is one clean rule and it is the difference between a count that is true and a count that is true in the demo |
| **3** | **Port the aggregation into `A-schematic.html`, taking one thing from each variant.** A2's mechanism (model transform, stack mark, windowed expansion, two terminals one state, document-level Escape with a priority ladder); A3's threshold of six; **A4's never-demoted count rule** — aggregate labels claim their boxes first and are exempt from the LOD gate | §3.1–3.8. No single variant is the answer: A2's counts vanish below zoom 0.6, A3's ladder rebuilds the texture, A4 spends a channel. Each got one part right |
| **4** | **Fix §6.1 and §6.2** — the forced-colours declaration and the dropped counts | Both are corpus contradictions, both are in the base, both are cheap |
| **5** | **Give the Outline a filter box.** `find SPOKE-57` is currently a scroll through 31 rows and a paged walk through the picture | §3.7's honest cost. Windowed expansion is a poor way to find one named thing; the Outline is the right tool and it is not searchable |
| **6** | **Salvage §4.6** — the computed `BOUNDARY` tag and per-terminal zone words, in text, with no hue | Two facts the picture does not currently state, for the price of two words |
| **7** | **Fix §6.3–6.9** | Housekeeping, but §6.3 needs a `56` §5.6 amendment and should not be lost |

### 7.2 Exit criteria

| # | Criterion |
|---|---|
| **X1** | `sibling_group_max` exists as a gated counter, ceiling 6, and the build fails above it |
| **X2** | At 4 spokes the aggregated and un-aggregated canvases are pixel-identical. Below the threshold, aggregation is a no-op |
| **X3** | At 12, 40 and 120 spokes the aggregated element count and scene extent are identical |
| **X4** | Every collapsed affordance's accessible name contains a cardinal and a named range. Asserted by walking the tree, in the same test `55` §3.4's monochrome check runs in |
| **X5** | Expand → collapse restores the element count **exactly**, and every node returns to its original coordinate |
| **X6** | No reachable state draws more elements than the un-aggregated form. (A3's ladder fails this today at 521 against 515) |
| **X7** | A group containing one member that differs in any declared attribute does not collapse that member. Fixture item 1 is the test case |
| **X8** | Every suppression chip in the view band carries a cardinal, asserted at 120 spokes, not at 4 |
| **X9** | **Every collapsed group's count is drawn in the picture at every zoom the group itself is drawn at**, asserted down the whole LOD ladder to 0.25. A2 fails this at 0.5 today |
| **X10** | Zero elements in the scene resolve to `--safe`, `--caution` or `--danger`, at any zoom, in any state, in either theme. Asserted by walking every painted element. This is `51` §3.3's `tokens/reserved-colour` lint applied to the SVG |

### 7.3 What the slice deliberately does not contain

- **No colour.** §4.1.
- **No new channel.** The stack is a repetition of an existing form (§3.5).
- **No threshold control in the product.** §3.2.
- **No selection-aware expansion anchor.** The machinery is there in A2; the wiring to selection is
  not, and it is a refinement of a mechanism that has not shipped.
- **No fifth candidate position for a label.** §6.7 is a plate-versus-text bug, not a placement
  shortage.

---

## 8. Failure modes

| # | Failure | What it looks like | What you will wrongly blame | The fix |
|---|---|---|---|---|
| 1 | **A collapse states a number and not a noun** | `+36` on a device wall. Nobody knows whether it is ports, units or peers | "the label is too small" | §3.6. Range and count, always, and the noun is in the accessible name |
| 2 | **A group collapses over a member that differs** | A stale spoke disappears into `40 spokes` and an engineer acts on eleven-month-old evidence | "the age rendering is broken" | §3.11. This is the most dangerous failure in this document |
| 3 | **The threshold is made a setting** | Two engineers screenshot the same estate and disagree about it | "the diagram is non-deterministic" | §3.2. Six is a constant |
| 4 | **Aggregation implemented inside the layout instead of before it** | The router, the channel allocator and the label placer each grow a collapsed-group special case, and crossings appear | "the router can't handle it" | §3.1. It is a model transform; the layout receives a smaller graph and is not modified |
| 5 | **Expansion offers "expand all" on an unbounded group** | The seventh click reproduces the texture, at more elements than never aggregating | "aggregation doesn't help" | §3.7, and X6. Measured on A3 at 521 against 515 |
| 6 | **The count is treated as a label** | Two forms. It goes through the placer, collides, and is suppressed as an unplaced label; or it passes the placer and is then dropped by the LOD ladder, leaving a stack of outlines with no number on it | "the label placer is greedy", then "you can't read anything at that zoom anyway" | §3.6, and X9. Counts claim their boxes first **and** are exempt from the LOD gate. A2 hit the first form and fixed it; A2 has the second form today, at zoom 0.5 |
| 7 | **The unit stub and the peer box get separate expansion states** | The hub says forty units and the column shows six spokes | "the state is out of sync" | §3.3. One group, one state, two affordances |
| 8 | **The collapsed group is drawn but not focusable** | A keyboard user can see forty things are hidden and cannot open them | "SVG can't take focus" | §3.8. `role="button"`, `tabindex="0"`, `aria-expanded`, one stop per terminal |
| 9 | **The suppression list loses its numbers as scale rises** | The band degrades from `41 edge labels off` to `edge labels off` exactly when the count matters | "the band is too crowded" | §6.2, and X8. The base does this today |
| 10 | **A hue is added to the diagram** | Somebody reads a green node as "safe to run" | "the legend was right there" | §4.1, and X10 as a lint. `56` §5.1 |
| 11 | **A future palette uses a lightness ramp as its non-chromatic carrier** | Stale nodes and one zone become indistinguishable in greyscale and in print | "greyscale was always going to be lossy" | §4.5, §5.7 rule 3. G1 owns tone. Measured Δ9 in A4 |
| 12 | **`forced-color-adjust: none` spreads** | A high-contrast user gets a white island in a black page, and the setting they chose is defeated | "high contrast mode is broken" | §6.1. `51` §6 permits it exactly once, on the egress band |
| 13 | **A forced-colours fallback is written at `:root`** | It works in light and silently loses to the dark override in dark, which is the default HC theme | "Chromium doesn't repaint SVG" | §5.6. Measured in A4 |
| 14 | **The picture is checked at four spokes** | Every claim holds, because below the threshold nothing fires | "it passed review" | §2.2, and X8. Test at the top of the range |
| 15 | **A parallel-edge collapse is drawn with two rails** | A reader sees a LAG where the estate has ten standalone links, and plans a change against a bundle that does not exist | "the bracket is missing" | §3.13, §3.14.1. G4 owns two rails and G5's stub owns *standalone*; the stack is three rails and keeps the stubs |
| 16 | **The ports collapse and the edges do not** | Ten lines land on a stack that draws one stub. **This is the behaviour the ladder specifies today** | "the router is duplicating edges" | §3.13's finding, and §3.14.4. One group, one state, three affordances |
| 17 | **A parallel group is keyed on the node pair rather than on the channels** | A tunnel, a LAG and six links between the same two boxes read as one edge saying `8 links` | "the count is wrong" | §3.14.2. Any channel that differs splits the group; a group of one is drawn as itself |
| 18 | **The count survives but the range does not** | `10 links` between two collapsed port stacks, and no way to tell which ten ports | "the label was too long for the gutter" | §3.6 and §3.14.1. An edge collapse hides **two** port ranges and must print both; the inspector names every member (§3.8) |

---

## 9. Open decisions

**DECISION — the threshold is six (§3.2).** **RECOMMENDATION — take it**, because `56` §5.4 already
collapses a like-kind list above six and one rule is better than two. The counter-case is A2's, and
it is not weak: Miller's span puts the counting break at seven to nine, and eight is the last count
at which a device's port field (8 × 16 px = 128 px) lands exactly on a rung of the quantised width
ladder `{96, 128, 160, 192}`. If a user test moves it, it moves to eight and not to four, and
`56` §5.4's VLAN rule moves with it.

**DECISION — expansion is windowed on unbounded groups and all-or-nothing on bounded ones (§3.7).**
**RECOMMENDATION — take it.** The rule is per group *kind* and the boundary is whether the set has a
natural cap: `ae` is capped at 64 by Junos and is unordered, so paging it is meaningless; a spoke
fan is unbounded and ordered by index.

**DECISION — no colour (§4.1).** **RECOMMENDATION — take it, and file §4.7's three gates so that
reversing it is a decision.** The owner asked for models in order to decide; both were built at full
fidelity on the same layout engine, and the answer the models produced is that A2 removed the reason
to want them.

**Open, not decided — where the exception carried out of a heterogeneous group is drawn.** §3.11
specifies *that* it is carried out, not *where*. Beside the aggregate, in the position it would have
occupied, is the obvious answer and it is wrong for a fan of 120 where the exception is member 3:
its natural position is at the top and the aggregate then reads as a residual rather than as the
group. **RECOMMENDATION — the exception is drawn adjacent to the aggregate, in index order relative
to it, and the aggregate's range string is split accordingly (`SPOKE-01–16`, `SPOKE-17`,
`SPOKE-18–40`).** That is three affordances where there was one, and it is the honest rendering.

**Open, not decided — whether port-level collapse should use the same threshold as peer-level.**
A3 names this and declines to invent a second number: *"a peer is a whole object and a port is a
detail"*, so there is a real argument that ports should collapse earlier than peers.
**RECOMMENDATION — one threshold until there is evidence for two.** Two numbers with no derivation
is worse than one number with two derivations.

**Open, not decided — the `56` §5.2 channel budget row.** The stack adds no row (§3.5) but the
*expansion state* is a new thing the picture says (`st0 · 6 of 40 shown` in a reserved band). It is
arguably G10 at the element rather than in the view band. **RECOMMENDATION — treat it as G10, and
record it in §5.2's G10 row rather than as an eleventh channel.**

**PROPOSED — a sixth aggregation level for parallel edges between one pair of nodes (§3.14).**
**RECOMMENDATION — take it, and take §3.14.2's grouping key with it**, because the key is what stops
the level from making the false claim the mark was designed to avoid. The counter-case is that six
was derived for a *stacked field on a device wall* — `56` §5.6's `layer_pitch ÷ --lh-micro` (§3.2) —
and an edge fan between two boxes is a horizontal quantity with no such derivation, so six is
imported here on the strength of *one rule is better than two* alone. That is the same argument §9
already makes for port level and it is weaker here. **If a render moves it, it moves once, for both.**

**Open, not decided — the gap between the three rails (§3.14.1).** `56` §5.3 owns the stroke tokens
and this document binds none. The value must keep a three-rail stack distinguishable from G4's
two-rail LAG (`--dg-rail-gap`, 3 px) and from the tunnel conduit (`--dg-conduit-gap`, 5 px) down the
LOD ladder. **RECOMMENDATION — do not pick the number in prose.** §3.5's node-level analogue was
measured merging at zoom 0.74; the edge-level figure has not been measured and inventing one would
be inventing a benchmark. Request against `56` §5.3.

**Open, not decided — whether `Cable` is drawn, and as what.** `56` §4.1's projection table predates
`19`'s physical model; `19` §3.8 says the `Link edge → line` row *"keeps working"* against the
derived `Cabled` edge, and the table was not amended to say so. `Cable`, `PhysicalPort`,
`PassiveNode`, `Premises` and `Terminates` have no row in it (§3.13). This is not this document's to
answer and it is not a detail: it decides what noun a parallel-edge count uses — `10 links` against
`10 cables` — and whether ten runs sharing one `Cable.assembly` are one fact or ten. `56` owns it.

**Requested against `53` (ADR-0024).** §3.8's disclosure semantics — `Enter`/`Space` to expand,
`Escape` scoped to the focused group to collapse — need to be either confirmed as instances of `53`
§2.2's existing Escape constant or bound explicitly there. This document binds nothing.

**Requested against `44`, `52` and `56`.** §2.4's two amendments and §3.9's band split. Each is
written as replacement text rather than as a complaint.

---

## 10. Sources consulted

- `design/diagrams/A-schematic.html`, `A2-aggregated.html`, `A3-overlay-colour.html`,
  `A4-zone-colour.html` — read in full and driven in Chromium 1194 under Playwright over `file://`
  at DPR 2, 1440 × 1200. Every element count, scene extent, fit zoom, hue angle, contrast ratio,
  greyscale byte, accessible name, tab stop and expansion ladder in this document was produced by
  that harness for this document.
- `design/tokens.css` — read, not edited. Verified untouched: last commit `a8007ce`,
  `git status design/` clean. Verified to contain no `pitch` token, which corrects A3's stated
  derivation of six (§3.2).
- `.context/field-card-srx-ipsec.txt` — the object chain, the six named objects, `external-interface`
  versus `st0`, `reth0.0` and `st0.N`, the security zones the fixtures group by. **The estate drawn
  in all four files is a fixture derived from this card and is labelled as one in every file.**
- `corpus/commands/junos-srx-ipsec.yaml` — the command text and risk bands in the inspector's
  command rules; 100 entries, every one carrying the `<named human>` placeholder in `reviewed_by`,
  so invariant 10 is not yet satisfied for any of them (§11).
- `.context/conventions.md` — the risk enum, invariants 2, 9 and 10, and the instruction to state
  trade-offs in the owner's voice.
- `docs/40-stack/44-performance-budgets.md` §4.7 (B12, B13, the element inventory, the LOD ladder,
  the canvas drag fallback), §4.7.4 (the 2,000-element decision §2.4 amends), §7.3 (the 5/20/50/200
  device scaling table and *"500 nodes is not 500 devices"*).
- `docs/50-design/56-diagram-view.md` — §3.3 (the ten layout phases the variants implement), §3.5
  (pins and the ordering seed), §3.6 (one scene, filtered), §5.1 (no colour, which §4 upholds), §5.2
  (the channel budget, G1–G10), §5.4 (**the edge vocabulary, and the `vlan 10–40 (14)` above-six rule
  that settles §3.2**), §5.5 (label placement, counted not dropped), §5.6 (`layer_pitch`, the width
  formula §6.3 amends), §8 (staleness without a fourth colour, which §4.5's greyscale finding
  protects), §12 (**the open decision §3.12 closes**).
- `docs/50-design/52-information-architecture.md` §3.6.1 (amended in §2.4), §9.3 (the view band, the
  two-fact rule, and the conflict §3.9 resolves).
- `docs/50-design/51-design-tokens.md` §1 R1 and §3.3 (the reservation and its lint, which §7.2 X10
  applies to the SVG), §3.2 and §3.4 (the reserved values and their measured contrast), §5.4 and §5.5
  (the dark set), §6 (forced colours, and *"`forced-color-adjust: none` appears exactly once"* —
  §6.1), §9 (dash and dot, spent), §13 (print), §14 (the token file §5 proposes an addition to).
- `docs/50-design/55-accessibility.md` §3.1 (R2 in operational form), §3.4 (the monochrome test §5.7
  extends), §3.5 (eleven axes, one uses colour — §4.2), §4.5 (the Outline), §7.3 (forced colours in
  SVG, and the age-line fallback §6.1 relies on).
- `docs/50-design/54-component-catalog.md` — the disclosure contract (`aria-expanded` +
  `aria-controls` + `hidden`) §3.8 follows.
- `docs/50-design/53-interaction-and-keyboard.md` §2.2 (Escape as one constant key).
- `docs/50-design/58-ui-direction-study.md` §2.3 (concept 03 aggregated at eight, held at 78 elements,
  and *"there is still no layout algorithm underneath it"*), §4 (the ADR-0006 collision §11 restates).
- `docs/90-decisions/adr-0011-risk-is-a-property-of-effect.md` (invariant 11),
  `adr-0006-v1-is-the-finder-and-the-product-is-phases-0-to-3.md` (Accepted; §11),
  `adr-0024-53-owns-the-keymap.md`, `adr-0026-theme-contrast-and-the-accessibility-claim.md`.
- `docs/70-ops/71-roadmap.md` §7 (phase 4, its deliverable, its exit criteria X4.1–X4.7, its 6–10
  solo weeks, and §7.1's *"for four phases the product has no picture"*).
- Miller, G. A. (1956), *The Magical Number Seven, Plus or Minus Two* — cited for the span of
  absolute judgment in §3.2, as a supporting argument only. The settling argument is `56` §5.4.

Added 2026-08-08 for §3.13–3.14, and read for this document rather than quoted from a summary:

- `docs/70-ops/70-owner-answers-and-standing-priorities.md` §10.1 — the owner's clarification,
  verbatim, and the correction it forced on the analysis that preceded it.
- `schema/schema.yaml` — `edge: Link` (`from: [Interface]`, `to: [Interface]`, `out: "0..1"`,
  `in: "0..1"`, `symmetric: true`, marked SUPERSEDED and retained); `edge: MemberOfAggregate` and
  `edge: MemberOfReth`; `edge: Terminates` (`from: [Cable]`, `out: "0..2"`); `edge: Cabled`
  (derived, `produced_by: infer.port.cabled-peer`); `kind: Cable` and its `assembly` field —
  *"grouping is a query, not a key."*
- `docs/10-core/19-service-and-physical-model.md` §3.4 (`Cable` promoted from an edge to a node; the
  breakout case — one QSFP cage, four lanes, four cables), §3.8 (`Link` superseded, `Cabled` derived,
  and its statement that `56` §4.1's row *"keeps working"*).
- `docs/10-core/11-ir-schema.md` §7.4 (`Link` is an edge, not a node), §7.6 (derived edges render
  `--muted` with an `inferred` tab — the channel §3.14.2 keys on).
- `docs/50-design/56-diagram-view.md` §4.1 (the projection table, and what is missing from it),
  §5.2 G4/G5/G10 (the two-rail and terminal channels §3.13 finds already spent), §5.3 (the stroke
  tokens §3.14.1 declines to set).
- `grep -n "Cable\|PhysicalPort\|PassiveNode\|Premises\|Terminates" docs/50-design/56-diagram-view.md
  docs/50-design/59-diagram-aggregation-and-colour.md` (run 2026-08-08) — one hit, `Cabled` at `56`
  §6.4. Nothing else.
- `grep -rn "GroupId" .` (run 2026-08-08) — one hit in the whole tree, `56` §3.5's type sketch.

---

## 11. Disagreements

None with the binding conventions. Five notes, the first of which is the one that matters.

### 11.1 This diagram work is probably premature, and the case deserves its strongest form

**The case against doing this at all, stated as well as I can state it.**

ADR-0006 is **Accepted**, dated 2026-07-28, and it decides that *"v1 is phase 0 alone"* and *"v1 =
the finder… **Nothing about a graph**."* It further decides, by name, that *"the diagram is cut to
an SVG export, saving 5–9 of 6–10 solo weeks."* `71` §2 sequences the graph as phase 1 (24–34 solo
weeks) and the diagram as phase 4 (6–10). `58` §4.2 adds those up: the diagram as a real view rather
than an export is reachable at **64–94 solo weeks**, and it then applies `83` §12.5's independent
re-costing factor of 1.5–1.6× to get roughly **96–150 solo weeks** — two to three years solo — and
notes that `71`'s headline number omits the corpus track entirely.

`71` §7.1 gives the reason the diagram is fourth and it is the brief's own reason: *"By phase 4 the
graph has survived a walkthrough, an emitter, a rule engine and a parser. There is no room left for
the diagram to invent state, because every property it would invent already has a home with a stable
ID and a provenance record."*

Against that: this is now the **third round** of diagram work. Round one produced five concepts whose
diagrams were rejected on aesthetics. Round two produced three more. This round produced three more
again, at a fidelity that includes a semantic rank table, a longest-path fallback, an eight-sweep
crossing reduction seeded from the previous ordering, an orthogonal router with interval-graph
channel allocation, a greedy four-candidate label placer, a crossing-knockout renderer, an inspector,
a hover chip and an Outline. That is a substantial fraction of `71` §7.5's *"layout 2.5–4 weeks"*,
spent on a deliverable the project's own accepted decision defers by one to three years — **while
the corpus, which ADR-0006 §6 identifies as the largest single line item and which invariant 10
blocks entirely, has 100 entries every one of which still carries the literal string
`<named human>` in `reviewed_by`.** By the project's own kill-signal logic in `71` §12.1, the thing
that should be under measurement right now is corpus authoring rate, and it is not being measured
by any of this.

The strongest form of the argument, in one sentence: **a project that has not yet had one corpus
entry reviewed by a named human has spent three rounds refining the aesthetics of a view its own
accepted roadmap deleted.**

**Why I do not take it, and where I concede it.**

Three reasons, and only the second is strong.

1. `56` §12 carries an unresolved open decision that this closes. Weak: an open decision that blocks
   nothing costs nothing to leave open.
2. **`58` §2.3 recorded the exact gap this round filled.** Round one's concept 03 aggregated at eight
   and held at 78 elements, and the study's verdict was: *"That is the correct answer and it is the
   answer `56` specifies. But there is still no layout algorithm underneath it."* There is now, and
   the thing it produced is not a picture — it is **a specification error found by drawing**: `44`
   §4.7.4's ceiling is off by two orders of magnitude for the failure people actually hit (§2). That
   correction would otherwise have been found in phase 4, against an implementation built to the
   wrong ceiling, and `44` §4.7.4 is cited by `56` §1.2, `56` §2.5, `56` §10 and `52` §3.6.1 — four
   documents that would have been wrong together.
3. `71` §7.1 names the cost of deferring the picture — *"for four phases the product has no picture,
   and a network tool with no picture is a hard demo"* — and these files are four self-contained
   demos that run from `file://` with two network requests and no build step. That is worth something
   to a project whose first year is keyboard demos, and it costs nothing to keep.

**The concession, and it is not small.** Reasons 2 and 3 justify *this* round. They do not justify a
fourth. **RECOMMENDATION — the next diagram work is gated on phase 1 existing.** Specifically:
§7.1's items 1 and 2 (the fixture and the heterogeneity guard) are finished now, because they are
cheap and because item 2 is the only unspecified part of a design that is otherwise decided; items 3
through 7 wait for a graph to render. If a fifth round of diagram studies is proposed before then,
this paragraph is the objection.

### 11.2 The owner is right about the collapse and wrong about the rendering, and the difference is the whole design

*"collapse them into a +# icon"* — the instinct is correct and the evidence for it is overwhelming
(§2.2). Two corrections, both stated plainly because burying them would produce the wrong thing:

- **A bare `+#` is the failure mode, not the fix.** `+36` on a device wall tells a reader that
  something was taken away and not what. It is worse than the texture, which at least said what it
  was made of. Every collapse in this design states a named range and a count, and the noun is in
  both the drawn label and the accessible name (§3.6).
- **It is not an icon.** `design-language.md` and `56` §5.1 (M31) permit a small closed set of
  typographic glyphs and no pictorial icons. The affordance is stroked geometry plus mono text — the
  form it replaces, drawn three times (§3.5). This matters because "icon" is how a picture-of-a-thing
  gets into a product that has spent four documents keeping them out.

### 11.3 The owner's framing of the colour question invited the wrong comparison, and the study corrected it

*"if you want to add colors make a model or two to see what it'll look like"* implies the comparison
is *diagram with colour* against *diagram without*. It is not. Both colour models also aggregate, so
the real comparison is **A3 or A4 against A2**, and A2 is a much higher bar than A-schematic. A2 says
this about itself and it is right: *"the colour models are not competing against A-schematic, they
are competing against this."* Had the models been compared against A-schematic, both would have
looked transformative, and the transformation would have been the aggregation.

### 11.4 `56` §5.1's stated reason for no colour is the weaker of the two available reasons

§5.1 argues from the risk reservation: a topology node rendered green reads as "safe to run". True,
and it is a constraint on *which* hues, not on *whether* — §5.3 measures 44.9° of clearance and the
constraint is satisfied. The stronger reason, which §5.1 does not give, is that **Fathom has nothing
for colour to encode**: invariant 2 and `11` §6.9 keep every piece of live state out of the graph
permanently, and live state is what colour is for in the tools that make it pay (§4.2, argument 3).
**Proposed change to `56` §5.1** — add that sentence. It is the reason that survives a future palette
that clears the reservation, and §5.1 as written does not.

### 11.5 Two claims inside the study files are wrong and are recorded here so they are not inherited

Both were checked because they are load-bearing, and both are stated in files that are otherwise
unusually honest.

- **`A4-zone-colour.html`'s PROPOSAL block, offered for adoption into `51` §14, contains a false
  measurement**: *"no zone hue can be read as ink or as de-emphasis when the colour is gone."*
  Measured greyscale: UNTRUST 92 against `--muted` 101 in light, Δ9; 153 against 147 in dark, Δ6
  (§4.5). The same sentence is printed at runtime in the file's Zone Key panel. **A block written as
  a proposed amendment to the token document must not carry a false measurement into it**, which is
  why it is named here rather than left in a review.
- **`A3-overlay-colour.html` states its threshold is derived from two tokens.** There is no `--pitch`
  and no `--portPitch` in `design/tokens.css`; the string does not occur in the file. The derivation
  is real and the terms are `56` §5.6's `layer_pitch` and `51` §14's `--lh-micro` (§3.2). Six survives
  the correction; the claim that it *cannot drift* does not, until the implementation reads both
  values rather than hard-coding them.
