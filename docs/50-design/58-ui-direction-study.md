# 58 — UI direction study: five rendered concepts, compared and decided

> **Status:** Proposed

Companion documents: `.context/owner-brief.md` (the authority — §6.1 the finder, §6.4 the
inventory that has opinions, §6.5 the diagram as a design tool), `.context/design-language.md`
(the idiom every concept had to be drawn in, and the source of the margin tab, the 4px accent
bar, the one-line imperative and the two-column hairline table),
`.context/conventions.md` (the ten hard invariants, the risk enum, and the instruction to state
trade-offs in the owner's voice), `50-design/51-design-tokens.md` §1, §4, §7–§12 (the
reservation rule, the channel budget, the type scale, and the fact that there is no animation),
`50-design/52-information-architecture.md` §1–§3, §5, §9 (the honest count, the sheet, the six
views, selection, and the scent budget — this document proposes no change to any of it),
`50-design/53-interaction-and-keyboard.md` §2.2, §8.3, §11.4 (**the sole owner of the keymap**
per ADR-0024 — this document binds no keys and reports where the concepts broke that ownership),
`50-design/54-component-catalog.md` §2.5, §6, §18 (the roving-list contract, the legend's
placement rule, the inspector), `50-design/55-accessibility.md` §1, §2, §4.5 (the qualified AA
claim per ADR-0026, the contrast floor, and the Outline), `50-design/56-diagram-view.md` (the
strongest document in the design set, and the one ADR-0006 §4 shelves),
`70-ops/71-roadmap.md` §2, §3, §4, §5, §7 (every effort figure in §4 below),
`90-decisions/adr-0006-v1-is-the-finder-and-the-product-is-phases-0-to-3.md` (Accepted, and in
direct collision with the owner's two stated goals — §4),
`90-decisions/adr-0025-restore-the-cards-density-and-channel-budget.md`,
`90-decisions/adr-0027-hardware-verification-and-the-verification-stamp.md`.

**The governing rule of this document, stated once, in caps, at the top:**

> **THE OWNER NAMED TWO GOALS AND BOTH OF THEM REQUIRE THE GRAPH. ADR-0006 IS ACCEPTED AND SAYS
> v1 HAS NO GRAPH. CHOOSING A DIRECTION HERE DOES NOT RESOLVE THAT; IT ONLY DETERMINES HOW
> EXPENSIVE THE COLLISION IS TO CARRY. §4 COSTS IT. DO NOT READ §5 WITHOUT READING §4.**

Five concepts were built as self-contained HTML files, driven in Chromium under Playwright, and
adversarially reviewed with measurements rather than readings. Every number attributed to a
concept below comes from those reviews. Every number attributed to the plan comes from `71` §2
and the per-phase effort sections. Nothing in this document is estimated by me.

---

## 0. Contents

| § | |
|---|---|
| 1 | What the owner asked for, restated — including the security absolute and what it forbids |
| 2 | The five directions, one subsection each |
| 3 | The comparison matrix, and what the scores mean |
| 4 | The ADR-0006 question — phase order per direction, costed from `71` |
| 5 | RECOMMENDATION — the paired ledger, and what is lost by not taking the runners-up |
| 6 | What to build first — the next slice, concretely |
| 7 | Failure modes |
| 8 | Open decisions |
| 9 | Sources consulted |
| 10 | Disagreements |

---

## 1. What the owner asked for

*margin tab: read this first*

### 1.1 The instruction, restated

Five statements, in the owner's order of priority:

| # | The instruction | Where it binds |
|---|---|---|
| 1 | **Security is the primary rule, above all else. Fathom never connects to anything.** | Invariants 1–4. Non-negotiable, and above every other row in this table |
| 2 | **Goal (a) — teaching and learning material** | Brief §6.1, §6.6; `15`; the explainer at three depths |
| 3 | **Goal (b) — inventory diagramming and management** | Brief §6.4, §6.5; `52` §3.6, §3.7; `56` |
| 4 | **The Termix layout instinct — blocking, easy to read. Layout only, not its networking** | §1.3 below |
| 5 | **Modularity and dynamic UI/UX — functionality addable at any moment. Below security, but real** | §1.4 below; the seams M1–M12 |

Row 1 is not a constraint on the design; it is a constraint on the product, and the design is
downstream of it. Rows 2 and 3 are the goals. Rows 4 and 5 are how the goals should feel.

### 1.2 The security absolute, and what it forbids this study from drawing

Invariant 1 says the application never opens a connection the user did not configure.
Invariant 2 says it never touches a network device. Invariant 3 says it never accepts a
credential. These are permanent product boundaries, not phase-1 limitations, and they delete
whole categories of interface before anything is drawn:

| Forbidden | Because |
|---|---|
| A connect button, a device picker implying reachability, a "run this" affordance, a live status indicator, a poll interval, a refresh timer, anything rendering device state as current | Invariant 2. Every command in the UI is a thing the user pastes into their own terminal. `31` §1.5: *"A total compromise of Fathom yields no reachability."* |
| A secrets field, a vault panel, a "save credentials" checkbox | Invariant 3. Emitted config carries placeholders, and the placeholder must be visible **as** a placeholder — `set security ike policy IKE-POL pre-shared-key ascii-text "<PSK>"` |
| An account, a login, a cloud badge, a share link, a "synced" indicator | Invariant 4, and sync is phase 5 regardless |
| A funnel, a first-run survey that submits, a "send feedback" control, telemetry of any shape | Invariant 1. `71` §3.7 states the consequence the owner must own: *"You cannot measure adoption… There is no funnel, no DAU, no retention curve, and there never will be."* |
| A spinner, a progress bar, a "computing…" state, a shuffled result order | Invariant 9. Determinism where observable, and `51` §12: there is no animation |
| A green shield, a lock icon, a "secure" badge, a trust score, or anything drawn in `--safe` to mean "offline" | `51` §1 R1. `--safe` means **read-only**, forever. Reusing it for "offline" is the single most visible failure a concept could make, and none of the five made it |
| The egress strip and the inversion band of `51` §4.2 / `52` §2.2 | The owner has ruled egress out without qualification. `--z-egress: 10` stays a layer the product never allocates, which is itself a statement |

**What the absolute makes possible, and no document currently draws.** The material for a
surface that proves the tool is offline — *legibly, checkably* — is real and citable:
`connect-src 'none'` in the artifact's own `<head>` (`34` §2.2); a two-entry WASM import
section, `fathom_entropy` and `fathom_now_ms`, verified by `wasm-objdump -x` against a committed
allowlist (`41` §3.7; `34` §7.5: *"This is the check that makes `connect-src 'none'` an
architectural property rather than a header"*); a published SHA-256 over the final bytes and a
locked toolchain (`71` §3.6 X0.3–X0.5); X0.9's 30-minute proxy test; the corpus as zstd frames
inside the same file (`52` §4.4); no browser storage at all in D1 (`71` §3.4). The right
rendering is one of the card's own two-column hairline tables and a footer line —
`offline artifact · sha256 <hash> · 2 wasm imports` — not a badge. §2 records which concepts
found this and which decorated around it.

### 1.3 The Termix instruction, precisely

Borrow the **layout instinct**: blocking, dense, everything in a known place, nothing hunted
for. Borrow nothing else — not its networking, not its session list, not its connection status,
not its terminal panes, not its host tree, which implies reachability and therefore violates
invariant 2 as a picture before it violates anything as code.

The nearest legitimate translation of *"everything in a known place"* already exists and is
`52` §2.2: one sheet, furniture that does not move, a view band in a fixed order that never
reorders (`finder · walkthrough · config · findings · diagram · inventory` — *look it up,
build it, read it, check it, see it, file it*), and a footer that names the neighbours. All
five concepts adopted that skeleton unchanged, which is the correct reading of the instruction.

**The risk in the instruction is the word "blocking".** If it means *fixed regions with stable
addresses*, the sheet already delivers it and §5's recommendation delivers more of it. If it
means *panels*, that is the dashboard `52` §2.1 rejects by name — six panels at one sixth the
density — and it is rejected because *"a dashboard optimises for glanceability, and nothing in
this product is glanceable: a finding you glance at is a finding you did not read."* This is
recorded as a disagreement in §10 rather than assumed away.

### 1.4 Modularity, as stated and as it has to be built

*"Functionality must be addable at any moment"* is a real requirement and it has a specific
shape in this architecture. Twelve seams exist (M1–M12 in the design set). The five that matter
for a UI direction:

| Seam | What plugs in | What the UI must show |
|---|---|---|
| **M1/M2 — rules are data; rule packs are signed bundles** | A whole domain (MPLS, BGP, NAT) arrives as a signed pack: `pack.toml` + `rules/<id>/rule.yaml` + fixtures (`63` §2–§4) | A packs listing with signer, version, rule count and review date; per-finding pack attribution on the row |
| **M3 — the corpus entry format** | A new command, a new platform's whole finder corpus, a new Rosetta mapping (`61` §3). ADR-0006 §7: *"The finder's corpus may be wide while the graph's corpus is narrow"* | The result row is **generated** from the entry's fields. An entry lacking `output_fields` renders one fewer line — never a placeholder, never an empty state |
| **M7 — the schema is data** | A new node kind gives new inventory columns, new diagram nodes, new rule targets and new explainer subjects at once, with no UI code (`11` §11.6, ADR-0008) | The inventory's columns are generated, not hand-written |
| **M5 — the view contract is three functions** | A new view is one more implementation of `primary` / `resolve` / `select_at` (`52` §3.1) — no framework registration, no route table, under ADR-0019's 800-line cap | The three-function contract as the literal shape of the extension point |
| **M10 — modes and layers are the extension point; a seventh view is not** | `verify(diff(graph))` became config·`ChangeSet`, a **mode**. `explain(node, depth)` became the explainer, a **layer**. New work lands as a mode, a layer, a diagram layer, an inventory kind or a rule pack | `52` §9.5: *"Six views fit. If a seventh is ever added, this design has a real problem and an overflow menu would be hiding it"* |

M10 is the one that constrains the answer to the owner's request rather than serving it. "Addable
at any moment" is true of modes, layers, packs, kinds and corpus entries. It is not true of
views, and a direction that makes adding a seventh view easy has made the wrong thing easy.

### 1.5 What the study was asked to produce, and what it actually produced

Asked: several rendered ideas before committing. Produced: five self-contained HTML files, each
carrying the CSP floor, the sheet skeleton, the risk legend on every view rendering a risk, a
teaching surface at three depths, an inventory surface with the opinions column, a labelled
fixture, an offline-provenance surface, and at least one named seam drawn with the words *"this
is where X plugs in"* on the page. Each was then driven in a browser and attacked.

**The fixture is derived, and every concept labels it.** No inventory exists in the corpus.
The estate in all five files is derived from `.context/field-card-srx-ipsec.txt` — hub-and-spoke,
two SRX devices in one site (which is what makes the population rule fire), `reth0.0` as the WAN
unit IKE leaves by, `st0.0` at `10.255.0.1/30` MTU 1400, gateway `GW-B` at `203.0.113.10`,
proposals `IKE-P1`/`IPSEC-P2`, policies `IKE-POL`/`IPSEC-POL`, traffic selector `TS1
local-ip 10.1.0.0/16 remote-ip 10.2.0.0/16`, zones TRUST/VPN/WAN, `tcp-mss ipsec-vpn mss 1360`.
Inventing it silently is the one dishonesty this design system has no device for, so every
table carries `fixture · not corpus data`.

**The verification stamp renders unverified, everywhere.** Every seed entry in
`corpus/commands/junos-srx-ipsec.yaml` carries the literal `reviewed_by: <named human>` and no
`verified_on`; the file's own header says *"NOTHING IN THIS FILE HAS BEEN RUN ON A BOX BY ITS
AUTHOR."* ADR-0027 makes the stamp required chrome, so the concepts render `junos-srx ·
unverified` and say why in a margin tab. No reviewer name was fabricated in any of the five.
`71` §3.6 X0.7 makes that a build failure, and X0.10 is the gate that clears it.

---

## 2. The five directions

Each subsection reports the concept's own thesis in its own words, what it optimises, what it
sacrifices, how it serves each goal, its extension seam, the adversarial verdict, and the file.
The verdicts are the reviewers' and they are quoted, not paraphrased.

### 2.1 Concept 01 — the workbench

**File:** `design/concepts/01-workbench.html`

**Thesis, its own words.** *"A workbench whose fixed regions are not navigation but a
permanently-visible estate, rule-pack list and seam register — so that the thing a workbench is
good at, muscle memory, is spent on teaching: one grain dial regrades every region on the screen
from reference card to lesson and back, without moving anything."*

**Optimises.** Recall over search. Every fact has one address on every screen: the legend is
always the fourth band down, the estate is always right, the refusal always appears in the
footer. This is the most literal reading of the Termix instruction in the set.

**Sacrifices.** The inspector — the estate column *is* the one second surface, spent
permanently. And, as measured, the 38% column is not `52` §2.3's pinned view at all: the
column's text is byte-identical across all six views, so it is a fixed pane, which is the IDE
model `52` §2.3 closes by rejecting. At 1280px it takes 486px — **38.0%** — against the 180–240px
(15–19%) `52` §2.1 uses to reject a left rail. Twice the cost of the thing rejected, for content
that is a subset of view 6.

**Teaching.** Corpus fidelity is genuinely high: three depths are three distinct texts
(measured 258 / 776 / 47 characters), the walkthrough refuses `st0.0` with the card's own reason
(*"st0 is the tunnel unit, not the WAN unit"*), answering `reth0.0` arms
`zone.host-inbound.ike-missing` and the band moves `2 high` → `3 high`. But the differentiating
move fails: `grainOf()` is referenced at exactly one site, inside an already-expanded block.
Cycling the dial with nothing expanded leaves canvas text length identical across all three
depths on all five non-walkthrough views, and the estate column contains **zero** grain-sensitive
regions. "Every region" measured as one region.

**Inventory.** Gestural. `ESTATE.map()` into one `innerHTML` string, 12 rows, no virtualisation,
no sort, no filter, and a hand-coded `<thead>` under a label claiming the columns are generated
from `schema.yaml`. The diagram is seven hand-placed rectangles in a hard-coded `viewBox`.

**Seam.** One real: the view registry — a single array of
`{id, label, tab, imperative, margin, primary, resolve, select_at, render}` that demonstrably
drives the band tab, the folio, the footer's neighbour labels and the `⌥←`/`⌥→` bounds. Adding
a seventh entry would wire itself up. Three asserted: rule packs are prose in a bay, schema
columns are a caption over a static header, provenance is a template rather than a resolver.

**Verdict.** *"**NOT VIABLE** — a documented keystroke (`s`) throws an uncaught `TypeError` at
`01-workbench.html:1252` that permanently destroys the findings view, and the concept's three
load-bearing claims are measurably false."* `⌥P`, the thesis's own stated escape hatch, loses
19% of canvas area at 1280px instead of returning it; suppression removes findings from the band
while the UI's own string says they stay counted.

### 2.2 Concept 02 — the runbook

**File:** `design/concepts/02-runbook.html`

**Thesis, its own words.** *"The application is one document, not six screens: the six
projections are sections in the card's own fixed order that you scroll through and act inside,
so a view switch moves your reading position rather than replacing the body."*

**Optimises.** Co-visibility and recall. Because nothing is replaced, the config you just read is
still above the findings that lint it, and `52` §3.8's two rules stop being promises — a view
switch cannot change the selection or scroll the previous view, because the previous view never
went anywhere. The legend is drawn once rather than six times.

**Sacrifices.** Scale, which the thesis names — and the concept ducks it with a six-row fixture.
And side-by-side comparison: a document has no second pane, so `52` §2.3's split is simply
unavailable.

**Teaching.** Strong in content, broken in structure. Three depths are real. But expanding a
finder hit inserts a bare `<li>` into a `role="listbox"`, so the entire teaching payload — depth
tabs, copy, walkthrough, cross-reference — sits inside a listbox as an illegal child with six
interactive controls in it.

**Inventory.** The best inventory of the five: columns genuinely generate from `SCHEMA`
(`Device` → seven columns, `IkeGateway` → seven different ones), with in-cell edit, filter,
marking and a bulk operation all verified working. The diagram beside it is six hardcoded SVG
boxes that a 2,000-device graph does not change, under a band tab reading a hardcoded
`diagram · 9 nodes` that matches neither the six drawn nor the 2,040 in the graph.

**Seam.** Half real. The schema→columns seam and the pack-mount gate work. `lint()` hardcodes
each rule's *condition* in JavaScript, so mounting `fathom.mtu` flips a boolean that gates a
condition already compiled into the page: the pack declares nine rules and contributes the one
already written into `lint()`. That is not *findings are data, not code*.

**Verdict.** *"**NOT VIABLE** — the one-document architecture makes the finder, the only surface
ADR-0006 ships, cost **1,119–2,638 ms per keystroke** at estate scale (versus 16–26 ms on the
six-row fixture), because every state change re-renders all six sections."* Against `44` §3 B5 —
keystroke to painted results, P95 16.7 ms, hard fail 33.4 ms — that is two orders of magnitude
over the hard fail, on the one surface v1 consists of. Separately, `esc()` escapes only `& < >`
and is used in attribute position, so the copy button on the `<PSK>` line — the concept's own
demonstration of invariant 3 — silently emits a truncated statement.

**Worth keeping regardless:** the design-law discipline was the cleanest in the study. Zero hex
literals, zero px font-sizes, zero transitions, and a computed-style sweep for the three reserved
colours returned 152 hits, all of them the visually-hidden risk word inheriting from its risk
parent — i.e. `51` §1 R2 working exactly as specified.

### 2.3 Concept 03 — the canvas

**File:** `design/concepts/03-canvas.html`

**Thesis, its own words.** *"One scene, four questions: the estate is drawn once, the picture
never moves, and config, findings, diagram and inventory stop being four places you go and become
four annotations of the same geometry — so switching view is switching question, and the picture
is the index into every other surface."*

**Optimises.** Spatial recall. The scene coordinates are stable across `⌥3`–`⌥6`, so *"the WAN
unit is the second box on the right"* stays true in the findings view. Every gesture terminates
in an op against the graph, printed in an op ledger under the scene — which is `56` §0's
governing rule made visible rather than asserted.

**Sacrifices.** The fold. Measured at 1280×800 with `scrollTop = 0`: the docked table's top edge
is at 713px, leaving **87px above the fold and zero rows visible** — diagram 0 of 16, findings 0
of 3, config 0 of 21, inventory 0 of 20. The thesis panel predicts *"under 300px… about eight
findings rows."* Understated by 3.4× and wrong by eight rows.

**Teaching.** Among the best. Three depths measured at 384 / 567 / 980 characters, all distinct;
the corpus quoted verbatim; ladders, `next_if_bad` and the ADR-0027 stamp all survive; the finder
works with no workspace. `f` on a real finding produces a change set whose line 1 is
`commit confirmed 5`, per `52` §3.4.1.

**Inventory and diagramming.** The only concept with an honest scale story for the picture: at
eight spokes the 2,000-element ceiling logic fires, the view aggregates, `52` §3.6.1's own
sentence appears, and the handoff is real — at 48 spokes the inventory carries 68 rows and the
band says so. Pushed to 1,984 spokes the scene stays at 78 elements. That is the correct answer
and it is the answer `56` specifies. But there is still no layout algorithm underneath it, and
the 40% closure dimming measures 1.79–2.56:1 on labels, against `55` §2's *"the 4.5:1 threshold
applies to every single glyph in the product, and the 3:1 allowance is never available."*

**Seam.** M8 (population rules) is real and interactive: `[ model it as a cluster ]` appends
`Op::AddNode { kind: ChassisCluster, name: SRX-DC-EAST, members: [dev-a, dev-b], provenance:
Hand }` to the ledger. M7 is asserted; `renderDock()` is a six-way `if/else` chain and `% 6` is
hand-written into the keymap. The page's live "bijection" counter compares `S.drawn.length` to
`S.drawn.length` and can never disagree.

**Verdict.** *"**VIABLE WITH FIXES** — the direction is sound and the security and teaching
halves are the best I have seen, but the inventory/diagramming half it exists to serve has zero
rows above the fold on the owner's own 1280×800 target."* The reviewer's closing observation is
the important one: the 713px of permanent furniture is *caused by* the divergent move, so
reclaiming the fold means a shorter or collapsible scene, and a collapsible canvas is concept 01
with a diagram in it.

### 2.4 Concept 04 — the console

**File:** `design/concepts/04-console.html`

**Thesis, its own words.** *"Fathom is a closed vocabulary of verbs over one graph and one
corpus, and its transcript is its audit log — so what this tool can do and what this tool just
did are the same list, printed on the screen, and neither list contains a verb that opens a
socket."*

**Optimises.** Speed for the returning user and **legibility of capability for the sceptical
one**. This is the best answer anyone produced to §1.2's unsolved surface: the security argument
stops being a claim in a colophon and becomes the same list the user operates the product with.
It is also the best answer to `53`'s governing rule — *"a binding with no visible affordance is a
feature only the author has"* — because the affordance is the vocabulary, printed.

**Sacrifices.** Three, named on the page. The ledger spends the one second surface. The command
line and suggestion strip cost ~44px of body permanently on top of ~210px of furniture. Below
1100px the ledger is gone and with it the security argument.

**Teaching.** Real and unbreakable under attack: 1,092 / 1,244 / 1,571 characters across the
three depths, all distinct. The teaching path is the *parse failure* — anything the vocabulary
does not recognise falls through to the finder as a corpus query, with the prediction shown
before Enter (`→ find (corpus) · 13 hits`) and the reason logged (`fell through: no verb "why"`).
A seventh view is refused by name; `suppress` without a reason is refused.

**Inventory and diagramming.** Inventory is real and the schema seam is genuinely generated —
injecting `SCHEMA.BgpNeighbor` plus a fixture and running `kind BgpNeighbor` regenerates the
header to `Neighbour / Peer / Remote AS / State / Provenance / Findings` with no view code
touched. The diagram is six hand-placed rectangles with no layout pass, no routing, no
aggregation, and no Outline at all — `<svg role="img">` containing six `<g tabindex="0">`, which
is the arrangement `55` §4.5 rejects.

**Seam.** The strongest demonstrated set in the study. A rule injected from a new pack
`fathom.bgp` renders and attributes at runtime (7 → 8 rows, `bgp.md5.absent` visible). The schema
kind regenerates columns. The pack strip carries both packs with signer and review date, and
`mtu.mss-clamp.absent` sits beside `ipsec.pfs.absent` — M1's stated demonstration, working. The
one asserted seam that does not hold: a new *layer* generates a fourth button and draws nothing.

**Verdict.** *"**VIABLE WITH FIXES** — the security floor, the token discipline, the teaching
path and two of three extension seams all survived an adversarial pass, but the concept as built
breaks its own responsive contract… throws keyboard focus to `document.body` on every action,
and ships diagramming as six hard-coded rectangles."* The responsive break is one line of cascade
order: `.pane-ledger { display: none }` inside `@media (max-width: 1100px)` is overridden by a
later equal-specificity rule, so at 1024×768 the view body is 220px tall behind 263px of
furniture.

**The structural objection, which is not a bug.** A command line is a mode. Measured: after
running any command, focus stays in the input, so `f` types the letter `f` instead of switching
to findings, and the only recovery is Escape. `53` §2.2 and ADR-0024 are explicit — *no modes, no
mode indicator, no mode errors* — and the concept also collides `Ctrl+K` with `:` by giving the
palette no input of its own, so you type into the command line *behind* the scrim. That is the
thesis, not the build.

### 2.5 Concept 05 — the ledger

**File:** `design/concepts/05-ledger.html`

**Thesis, its own words.** *"Every fact the product holds is posted twice — once as structure on
the left, once as meaning on the right — and where the second posting is missing the ledger says
so out loud instead of pretending the row is complete."*

The sheet is `52` §2.2's furniture unchanged and the body below it is permanently two columns:
fact at 62%, meaning at 38%, never one, never three. The left column is whichever of the six
views you are in; the right column is `52` §4.2(b)'s margin drawer with its pin welded shut.

**Optimises.** Co-visibility of evidence and explanation — *"the one thing `52` §4.2 says an
explainer must never make you trade."* It does not invent a second surface: `52` §2.3 as amended
by R35/ADR-0025 already says the pinned pane and `54` §18's inspector are the same surface, and
62/38 on 1132px of content gives 702/430, which is the 420px inspector to within a rounding step.
The ledger welds open a column the architecture has already budgeted.

**Sacrifices.** The second view, permanently and unrecoverably. `⌥P` pinning config beside
findings is gone. This is the largest single cost in the study and the concept states it first.
Second: adjacency — the explainer is beside the thing rather than under it, so the inline
expansion of `52` §4.2(a) is displaced.

**Teaching.** The strongest of the five, and the difference is structural rather than editorial.
Three real corpus texts per depth; sources, `acceptable_when` and the ADR-0027 stamp on every
posting; and the coupling proof holds under measurement — selecting `unit.st0-0` in the diagram
and selecting the `st0.0` inventory cell produce **byte-identical** meaning text (981 characters,
identical), which is `52` §5.1's facet model working rather than being described.

**Inventory and diagramming.** The weakest half, and the reason is the cursor model, not the
room. `ArrowDown` in the inventory moves *across* the row — measured `SRX-A → Device → DC-EAST` —
because the cursor is a linear DOM-order walk over `[data-post]`, which in a table is row-major.
The owner's stated inventory task, *sort by the opinions column and read down it*, is not merely
cramped; it is unavailable. The diagram is ten hard-coded coordinates.

**Seam.** M2 is real: the packs table renders, the `fathom.mpls` row's dotted rule computes
correctly, and `mtu.mss-clamp.absent` renders byte-identically to `ipsec.pfs.absent`. M7's
generated column strip is real (8 → 9 headers). M5 is asserted and absent: `RENDER` is one
function per view; `primary()` is a static string table, `resolve()` is one global `tierOf()`
hard-coded to `S.sel.anchor === eid`, and `select_at()` is a global click delegate.

**Verdict.** *"**VIABLE WITH FIXES** — the double-entry idea survives (the id-keyed coupling is
byte-identical across renderings and the teaching column is the strongest half of any goal in the
brief), but this build does not ship: below `--bp-cols` the fact column collapses to zero height
and takes twelve invisibly-focusable controls with it."* At 800px the masthead reads `CONFIG`,
the band reads `▸config · 26 lines`, the footer reads `VIEW 3 OF 6 — CONFIG`, and
`factBody.clientHeight === 0` with `scrollHeight === 618`.

### 2.6 What all five got right — the common floor

This is worth stating because it means the floor is not in dispute and no direction has to argue
for it.

| | Result across all five |
|---|---|
| **Network egress** | Zero `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, remote font, remote image, remote script or remote stylesheet in any file. Driven: **exactly 2 requests per concept, both `file://`** — the page and `../tokens.css`. Zero failed requests |
| **CSP** | Present in every file at or above §1.2's floor, including `form-action 'none'` — which is not optional, because a form submission is a navigation and `connect-src` does not cover it (`34` §2.3) |
| **Token discipline** | Zero hex literals, zero px font-sizes, zero durations, zero transitions or animations in the concept CSS of all five. `--radius` and `--shadow` appear only through the token |
| **The reservation rule** | `51` §1 R1 held everywhere. Computed sweeps found the three risk colours only inside risk selectors. Nobody drew "offline" in `--safe`, which was the trap |
| **ADR-0011** | Risk marks appear on command rows and config lines only. Findings rows carry severity bars in the `--ink`/`--muted`/`--hairline` neutral ramp and zero risk marks |
| **The legend** | Present, visible and un-collapsed on every view rendering a risk, in every concept — `54` §6's placement rule, honoured five times out of five |
| **Fixture honesty** | Every table labelled `fixture · not corpus data`; no reviewer name fabricated; the stamp renders `unverified` |

### 2.7 What all five got wrong — and one of them matters more than any concept

Three failures are common to the set. The third is the finding of the study.

**(1) Nobody implemented the roving-list contract.** `53` §8.3 and `54` §2.5 specify it once, for
finder results, config lines, findings and inventory rows: *"Every list is **one tab stop**, not
n… the config view for one device holds ~4,000 lines. Without a roving tabindex, `Tab` from the
view band to the footer is 4,000 presses."* Measured: 01 has ±1 only, no `Home`/`End`/`PageUp`/
`PageDown`, and 12 raw tab stops in its estate; 02 makes the whole config section unreachable by
Tab (0 of 24 lines focusable); 03 ships 19, 20 and 3 tab stops in three lists the spec names, and
2,004 at scale; 04 loses focus to `document.body` on 10 of 10 activations; 05 ships 96 tab stops
in a ten-row inventory, one per **cell**. Every concept treated a specified contract as
implementation detail. It is not: it is the difference between a keyboard-operable product and a
tab-order trap, and it is cheap in a first-party render layer where every list goes through one
function.

**(2) Nobody trapped the finder palette, and everybody declared it modal.** All five ship
`role="dialog" aria-modal="true"` with no trap and no `inert` on the rest. `aria-modal="true"` is
a statement to assistive technology that the rest of the page is unavailable; it was false in
five files out of five. In 05 it is worse in both directions at once — the legend falls outside
the dialog, so a screen-reader user loses the legend whose visibility is the stated reason for
that exact placement (*"the risk legend is exactly the thing you want visible while looking at a
command you are about to run"*), while a sighted mouse user can still operate the chrome behind
the scrim.

**(3) No concept implements diagram layout. Not one.** 01 hand-places seven rectangles. 02
hand-places six and prints a fabricated node count beside it. 03 hand-places its scene and then
builds an honest aggregation ceiling on top of geometry that was never computed. 04 hand-places
six. 05 hand-places ten. Across five files there is no placement pass, no orthogonal routing, no
collision test, no label-candidate placement, and no hit-test grid. `71` §7.5 puts layout at 2.5–4
of phase 4's 6–10 solo weeks and `56` §3 specifies the algorithm in full, so this is not a
surprise — but it has a consequence the owner must hear plainly:

> **The study cannot tell the owner anything about the diagramming half of goal (b). Five
> concepts were rendered and none of them drew a diagram; they drew five pictures of a diagram.
> Any claim below about a direction's suitability for diagramming is a claim about how it *hands
> off* to the picture, not about the picture.**

The one concept that produced real evidence in this area produced it by *refusing* to draw: 03's
aggregation ceiling fires at eight spokes, collapses to Site/Device, and hands off to the
inventory with the count in the band. `52` §3.6.1 already says that is the true answer and that
it is worse than the answer the engineer wanted. It is still the only measured result in the set.

---

## 3. The comparison matrix

### 3.1 What the scores mean

Four ordinal marks, defined once. They are not numbers, they do not average, and there is no
total row.

| Mark | Means |
|---|---|
| **●●●** | Demonstrated and measured working under adversarial driving |
| **●●** | The mechanism exists and was measured working in part; a measured defect bounds it |
| **●** | Asserted on the page, or the mechanism exists and was measured **not** to do what the page claims |
| **○** | Absent, or measured broken to the point of unusability |

**There is no total, deliberately.** The eight axes are not commensurable; the owner has already
ordered three of them (security first, then teaching, then inventory) and weighting the remaining
five would manufacture a decision the measurements do not support. §5 states the ordering it
applies and why, in words, where it can be argued with.

### 3.2 The matrix

| | **01 workbench** | **02 runbook** | **03 canvas** | **04 console** | **05 ledger** |
|---|---|---|---|---|---|
| **Security legibility** — how well the artifact makes "offline, checkably" readable | ●● honest artifact table; `not built` / `not asserted` rows rather than a fabricated hash | ●● colophon self-audit; reads `localStorage.length` live | ●●● 16-row audit computed from the live DOM | ●●● the transcript **is** the capability list; the best idea in the study | ●● CSP audit and packs table; the weakest provenance surface of the five |
| **Teaching, goal (a)** | ●● three real depths; the bench-wide dial reaches one block and zero of the estate | ●● three real depths; the payload sits inside a listbox as an illegal child | ●●● verbatim corpus, ladders, stamps, `next_if_bad` | ●●● parse failure **is** the teaching path; fall-through predicted before Enter | ●●● explanation never traded against evidence; byte-identical coupling across renderings |
| **Inventory + diagramming, goal (b)** | ● 12-row `map()`; 7 hand-placed rects | ● best inventory in the set; band prints a fabricated node count beside 6 hard rects | ●● only honest scale story: ceiling fires, hands off to the table — but 0 rows above the fold at 1280×800 | ●● real inventory, generated columns, live kind switch; 6 rects, no Outline | ● rows are real; the cursor walks row-major so the opinions column cannot be read down |
| **Modularity** | ●● one working seam (view registry drives band, folio, nav); three captions | ●● schema→columns and pack gate real; `lint()` compiles rule conditions into JS | ● M8 real and interactive; `renderDock` is a 6-way `if/else`; the bijection counter is a tautology | ●●● rule injected from a new pack at runtime; new schema kind regenerates columns; both verified | ●● packs table and generated columns real; `primary`/`resolve`/`select_at` absent |
| **Keyboard operation** | ● no `Home`/`End`/`PgUp`/`PgDn`; 12 raw estate stops; listbox with 0 options; 9×20px targets | ○ focus → `BODY` on 4 of 4 activations; config unreachable by Tab; `⌥1`–`⌥6` dead on macOS; `⌥←` wraps against `53` | ● 19/20/3 tab stops where the spec says 1; arrows mutate the graph from unrelated panes | ● focus lost 10 of 10 leaving the command line; verbs dead after Enter; palette has no input of its own | ● 96 tab stops in a 10-row table; `ArrowDown` hijacked globally so the teaching column cannot be scrolled |
| **Density / readability** | ●● clean tokens, legend on all six; diagram type reaches 30px at 2560; sheet never caps at 1180 | ●●● cleanest design-law result in the study; horizontal document scroll below ~1100px | ● 40% dimming measures 1.79–2.56:1; a hairline bounds a band, forbidden by name in `55` §2.5 F1 | ●● clean tokens and legend; 18 of 27 targets under 24px; the suggestion strip clips focusable buttons | ● literal stroke-widths and a raw `2 3` dasharray in the one place the dash reservation matters; 29 independent line scrollers below ~950px |
| **Behaviour at scale** | ● no virtualisation; 12 estate elements already fill 2.3 screens | ○ **1,119–2,638 ms per finder keystroke** at estate scale; 53,634 nodes; a 175,387px document | ●● config scroller caps and the page does not grow; ceiling honest; a layer toggle costs 1,138 ms at 2k rows | ● 182–219 ms renders, 210–329 ms per keypress against B5's 16.7 ms P95 | ● both columns torn down and rebuilt per cursor move, linear in rows; ~16,000 tab stops at 2,000 rows |
| **Build cost** *(relative, with the reason)* | **Medium.** The shell is already specified; the estate column is view 6 duplicated — but it forces phase 2 to exist before the layout is honest | **High.** Virtualisation *inside* a scrolling document is the expensive part and it is the part the concept ducked | **Highest.** Needs `fathom-layout` (2.5–4 of phase 4's 6–10 solo weeks), the Outline bijection, hit-testing and the ceiling — none of which exists here | **Low–Medium.** Verbs are data and the transcript is an append-only list; the cost is a *design* cost — the command line is a mode, and `53`/ADR-0024 forbid modes | **Lowest.** Two columns, one cursor, one explainer layer. `52` §2.3 and `54` §18 already budget the 420px column it uses |

### 3.3 Three readings of the matrix

**Nobody wins on keyboard.** The best mark on that row is `●`. This is not five bad builds; it
is one missing shared component. In a first-party render layer capped at 800 lines (ADR-0019)
every list goes through one function, so the roving contract of `53` §8.3 is written once and is
then structurally impossible to omit. Whichever direction is chosen, that function is in the
first slice.

**The security row and the modularity row point at the same file.** 04 holds the only `●●●` in
both, and for the same reason: it made *capability* a rendered object. A verb table that a rule
pack extends and a transcript that logs every verb are the same list read forwards and
backwards, and `34` §7.5's import-section check is that argument in the toolchain rather than in
the UI. That idea is separable from the command line that carries it, which matters in §5.

**The two goals do not select the same winner, and one of them cannot be selected on.** Goal (a)
selects 05, then 03 and 04. Goal (b)'s *inventory* half selects 02 and 04; its *diagramming*
half selects nothing, per §2.7(3).

---

## 4. The ADR-0006 question

*margin tab: read this before §5*

### 4.1 The collision, stated without smoothing

ADR-0006 is **Accepted**, dated 2026-07-28, and it decides:

> *"**v1 is phase 0 alone**… **v1 = the finder.** A command reference that closes the vocabulary
> gap, offline, deterministically, with what to read in the output and what to run next if it is
> bad. **Nothing about a graph.**"*

It further decides (§4) that *"the diagram is cut to an SVG export, saving 5–9 of 6–10 solo
weeks."* `71` §3.4 lists what is deliberately not in phase 0: context awareness → phases 1 and 5;
**any rule, any finding** → phase 1; suppression, workspace and settings persistence → phase 5;
generated ladders → phase 3. `71` §2 sequences the graph as phase 1 and the inventory as phase 2.

The owner has now named two goals, in order: (a) teaching and learning material at three depths,
(b) inventory diagramming and management. **Both require the graph.** `lesson = explain(node,
depth)` explains a *node*; `inventory = table(graph)`; `diagram = render(graph)`. Phase 0 has one
view and no graph, so under ADR-0006 goal (b) does not exist at v1, and goal (a) exists only in
its corpus-only form — explainers attached to command entries, not to the user's own estate.

### 4.2 Costed, using `71`'s own figures

Solo and team-of-three columns are `71` §2's, unmodified:

| | `71` §2 solo | team of 3 |
|---|---|---|
| Phase 0 — the wedge (= ADR-0006's v1) | 12–18 wk | 6–9 wk |
| Phase 1 — graph, one platform, one task | 24–34 wk | 12–17 wk |
| Phase 2 — paste and inventory | 14–20 wk | 7–10 wk |
| Phase 3 — findings, diff, verify, rollback | 8–12 wk | 4–6 wk |
| Phase 4 — the diagram (cut by ADR-0006 §4) | 6–10 wk | 3–5 wk |

| Scope | Phases | Solo | Against v1 |
|---|---|---|---|
| ADR-0006's v1 | 0 | **12–18 wk** | — |
| The minimum that satisfies **both** stated goals | 0+1+2 | **50–72 wk** | **≈4× v1's scope at both ends of the range** |
| …plus findings, so the inventory's opinions column has something to aggregate | 0+1+2+3 | **58–84 wk** | ADR-0006 §3's own number for "the product" |
| …plus the diagram as a real view rather than an SVG export — *"diagramming"* is the owner's word | 0+1+2+3+4 | **64–94 wk** | and it un-books a saving ADR-0006 recorded by name |

**Treat those as a floor, not an estimate.** Two corrections apply and both push up. `83` §12.5
re-cost the same plan independently and found `71`'s inputs low by a factor of **1.5–1.6** at the
whole-plan scale (170–240 solo weeks to phase 7 against `71`'s 106–158); applied to 64–94 that is
roughly **96–150 solo weeks**. And `71` §2's headline *"omits the corpus entirely"* — 20–30
person-weeks of expert domain time, per ADR-0006 §6, which is the largest single line item and
the one every reader's number excludes.

### 4.3 What each direction implies for phase order

The question is not "is this direction nice" but "what must exist before this direction is
honest on screen".

| Direction | Minimum phases for the layout to be truthful | Solo weeks beyond v1 | Why |
|---|---|---|---|
| **01 workbench** | 0+1+2 (**50–72**) | **+38–54** | The estate column is 38% of the screen and never changes job. With no graph it is 38% of empty, which the concept's own thesis panel concedes |
| **02 runbook** | 0+1+2+3 (**58–84**) | **+46–66** | Six sections in a fixed document order. Five empty sections you scroll *past* are worse than five you can choose not to switch to |
| **03 canvas** | 0+1 to exist at all (**36–52**); only interesting at 0+1+2+4 (**56–82**) | **+24–34** minimum | The scene persists across every view, so the graph is a precondition of the shell itself. And it reverses ADR-0006 §4 |
| **04 console** | **0 alone** | **+0** | The vocabulary shrinks with the phase. At v1 it is `find`, `explain`, `depth`, `copy`, `platform`, `rosetta`, and the transcript logs corpus verbs |
| **05 ledger** | **0 alone** | **+0** | At v1 the fact column is finder results and the meaning column is the explainer at three depths — which is phase 0's product, drawn |

### 4.4 The reversal is not listed as a trigger, and that is deliberate

ADR-0006's *"Revisit if"* clauses are: a pilot engineer opening a workspace twice unprompted; a
measured authoring median at or below 25 minutes across 200 entries; a second full-time person
joining; pilots reporting the finder is useful only with a workspace open. **"The owner names
inventory and diagramming as a goal" is not among them.** ADR-0006 anticipated this exact
collision and filed it as a *cost* rather than a trigger:

> *"**This is a decision to ship substantially less than the brief describes, and the brief is the
> authority.** One graph, six views is the owner's thesis; v1 has one view and no graph. That gap
> has to be stated to the owner as a proposed change, not discovered by them at the download
> page."*

It also concedes: *"Cutting the diagram removes the product's only demonstrable surface… a
project with no diagram is much harder to explain to anyone who has not used it."*

The owner brief is the authority (ADR-0001). ADR-0006 is Accepted. Both are in force and they
disagree. This document does not resolve that; §5 chooses the direction that makes the
disagreement **cheap to carry and continuously visible**, which is the only contribution a UI
study can honestly make to it.

---

## 5. RECOMMENDATION

### 5.1 The decision

**RECOMMENDATION — take concept 05, the paired ledger, as the direction, with two named
adoptions and two rejections. Do not reverse ADR-0006 to do it.**

| | |
|---|---|
| **Base** | **05, the paired ledger.** The body below `52` §2.2's unchanged furniture is permanently two columns: fact at 62%, meaning at 38%, never one, never three |
| **Adopt from 04** | **The transcript as the meaning column's third face** — an append-only, in-memory list of every verb the session ran, headed by the artifact's own audit rows (CSP read from the live `<meta>`, request count, the two WASM imports, the artifact hash). This is the §1.2 surface, and 04 is where it was invented |
| **Adopt from 03** | **The aggregation ceiling and the handoff.** Above `44` §4.7.4's element ceiling the picture collapses to Site/Device and names the count, and the honest answer is the table. This is the only measured scale result about the picture in the whole study |
| **Adopt from 01** | The view registry as one array driving band tab, folio, imperative, margin tab and neighbour labels — the single working seam that concept produced |
| **Reject** | **01 and 02, outright.** Both were measured NOT VIABLE, and in both cases the fatal property is the thesis rather than the build: 01's estate column is the fixed IDE pane `52` §2.3 rejects, at twice the width `52` §2.1 used to reject a rail; 02's one-document render makes the finder pay for the estate on every keystroke |

**The argument, in one paragraph.** The ledger is the only direction whose divergent move is
*already budgeted by the architecture*: `52` §2.3 as amended by R35/ADR-0025 says there is one
second column at 62/38 = 702/430px and that it is `54` §18's inspector; the ledger does not add a
surface, it welds that one open and assigns it a job. That makes it the cheapest direction to
build (§3.2's Build cost row) and the only one besides 04 that is truthful with no graph. It
serves goal (a) better than anything else in the study, by structure rather than by content:
explanation is never traded against evidence, and the coupling is over `ElementId` rather than
over a rendering, which is invariant 7 and `52` §5.1 made visible. And its honesty device —
a row whose meaning column reads `UNPOSTED` instead of pretending completeness — is, without any
extra work, the phase-boundary information design §4 says the owner needs:

> **A meaning column that reads `UNPOSTED — graph-backed; not in this build` renders the ADR-0006
> boundary per row, in the product, continuously. The owner does not have to hold the phase plan
> in their head to see which half of the product exists. That converts §4's collision from a
> decision taken once, in the dark, into a fact the artifact displays every time it is opened.**

No other direction in the study can do that. 01 and 02 render absence as empty regions. 03
renders absence as an empty scene, which is the whole screen. 04 renders it as a shorter verb
list, which is honest but silent — a missing verb does not announce itself.

### 5.2 The four measured defects that must not be read as objections to the direction

Concept 05 was measured VIABLE WITH FIXES, and three of its five worst results are build defects
with specified answers already in the design set:

| Measured defect | It is not a thesis problem because |
|---|---|
| Below `--bp-cols` (860px) the fact column computes to **zero height**, taking twelve invisibly-focusable controls with it | `52` §4.2(a) already specifies the correct behaviour: the explainer's **default** placement is inline expansion under the thing, pushing content down. Below the breakpoint the meaning column becomes that inline expansion. The pane does not collapse; it changes placement, which is a placement the layer already has |
| `ArrowDown` in the inventory walks **across** the row (`SRX-A → Device → DC-EAST`) | The cursor was built over DOM order. `52` §5.1 already answers it: `↓` walks `ElementId`s (rows), and narrowing to a cell is `Facet::Field(FieldKey)`, reached sideways. *"Facet exists because narrowing is lossy."* The fix is to build the specified model, not to change the layout |
| 96 tab stops in a ten-row table, one per cell | §2.7(1). Universal across the study; one shared list component fixes it in all six views at once |
| `▸` appears in the view band **and** in a row gutter forty pixels apart | `51` §4.2 assigns `▸` to selection and nothing else. The band's current tab already carries `aria-current`, ink weight and a 3px underline. Delete the glyph from the band |

The fifth is a content-assignment defect that the reviewer read as a thesis refutation, and I
disagree with that reading — see §10.

### 5.3 What is lost by not taking the runners-up. Named, not softened.

**Not taking 03, the canvas.** Lost: *the picture as the index*. 03's genuine contribution is
that spatial memory is an addressing mechanism — "the WAN unit is the second box on the right"
stays true across `⌥3`–`⌥6` — and no amount of table design recovers that. Also lost: the op
ledger under the scene, which makes `56` §0's governing rule visible rather than asserted.
Partially recovered: the aggregation ceiling and the handoff are adopted, and the ledger's
meaning column can carry the op for a diagram gesture, which is the same information without the
persistence. **Not recovered, and it is the real cost:** in the ledger the diagram is one of six
views in a 702px column, so it is the concept's weakest view rather than its organising
principle. If the owner's phrase *"inventory diagramming"* means the picture is the primary
surface, §5.1 is the wrong recommendation and §8's first open decision is the one to take.

**Not taking 04, the console.** Lost: *the closed verb vocabulary, printed*. It is the best
answer anyone produced to `53`'s governing rule — *"a binding with no visible affordance is a
feature only the author has"* — and it makes capability legible to a sceptical reader in a way
no colophon does. Recovered: the transcript, which is the half that carries the security
argument. **Not recovered:** the vocabulary strip itself. The reason it cannot be the base is
structural and not fixable — a command line is a mode, `53` §2.2 and ADR-0024 forbid modes by
name, and the measurement bears it out (after Enter, `f` types `f`). A direction whose signature
control is prohibited by the document that owns the keymap is a direction that must win an ADR
first.

**Not taking 01, the workbench.** Lost: almost nothing the ledger does not also give, which is
why it is a rejection rather than a runner-up. The permanently-visible estate is view 6 rendered
twice; the ledger gives a permanently-visible *second column* whose contents change with what you
are looking at, which is the same fixed address with a job. The view registry is adopted.

**Not taking 02, the runbook.** Lost: *cross-section co-visibility* — the config you just read
sitting above the findings that lint it — and the argument that the legend is drawn once rather
than six times. The ledger recovers the version of co-visibility that matters most for goal (a),
evidence beside explanation, and recovers nothing of the other. **And this compounds the
direction's own largest cost:** the ledger spends the one second surface permanently, so `⌥P`
pinning config beside findings is gone and `52` §2.3's split is unavailable inside this
direction. A user who wants two views at once cannot have them. That is stated in 05's own thesis
panel as *"the largest single cost and it is not recoverable inside this direction,"* and I am
not going to pretend otherwise: it is the price of the recommendation, it is permanent, and the
owner should agree to it explicitly.

### 5.4 What the recommendation does to §4

Nothing, and that is the point.

- **ADR-0006 stands.** v1 remains the finder alone. The paired ledger *is* the finder at v1 —
  results left, three depths right — so the shell shipped in phase 0 is the shell shipped in
  phase 3, and phase 1's graph fills the left column rather than replacing the product.
- **The reversal of ADR-0006 §4 (the diagram cut) is proposed as a separate decision and
  deferred**, with its price on the table: +6–10 solo weeks, and it un-books the 5–9 weeks
  ADR-0006 recorded as a saving. §8 carries it as an open decision with a recommended trigger.
- **Goal (b) is not served at v1 and this document does not claim otherwise.** It is served at
  phase 2 — 50–72 solo weeks cumulative — and the `UNPOSTED` device is what makes that legible
  in the meantime rather than merely documented.

---

## 6. What to build first

*margin tab: one slice, not a phase*

### 6.1 The slice

**The paired ledger at phase 0: the finder in the fact column, the explainer at three depths in
the meaning column, and the transcript as the meaning column's third face.** Nothing about a
graph. This is `71` §3.3's phase-0 UI line item — *"render layer, keyed reconciler, virtualised
list, overlay, result row, explainer panel, tokens," 2.5–3.5 solo weeks* — spent on this shape
rather than on a single-column one. It does not add a week to phase 0, and that is the test it
has to pass.

| # | What | Source it comes from, not invented here |
|---|---|---|
| 1 | The sheet: 3px ink rule, masthead (title, subtitle, one-line imperative), 1px rule, risk legend, 1px hairline, view band, 1px hairline, body, 1px rule, footer. ~210px, and it does not scale with anything | `52` §2.2, R36/ADR-0025 |
| 2 | The two-column body at 62/38, `⌥[` / `⌥]` for 50/50, **and below `--bp-cols` the meaning column becomes an inline expansion under the fact row rather than a collapsed pane** | `52` §2.3; `52` §4.2(a) is the fallback placement, so this is not a new behaviour |
| 3 | **One list component, with the roving contract in it**: a list of *n* rows is one tab stop; `↑` `↓` `Home` `End` `PageUp` `PageDown`; `aria-describedby` pointing at a `.vh` instruction. Used by the finder results and by every later list | `53` §8.3, `54` §2.5. §2.7(1) is why this is item 3 and not item 30 |
| 4 | The finder as a real ARIA combobox: focus stays in the input, `aria-activedescendant` moves, every option carries an `id` | `16` §19.3 via `53` §8.3. Measured absent in all five concepts |
| 5 | The result row **generated from the corpus entry's fields** — an entry with no `output_fields` renders one fewer line, never a placeholder | M3, `61` §3 |
| 6 | The three depths as three texts with a lowercase margin-tab control (`terse · explained · teaching`), `⌥\` or `v` to cycle, per-block override forgotten when the block closes. No settings screen, no dropdown, no radio group | `15` §4, `52` §4.3, M6 |
| 7 | The ADR-0027 stamp on every result row and every explainer header, in muted mono at margin-tab weight, rendering **`junos-srx · unverified`** until X0.10 is met | ADR-0027, `52` §3.2 |
| 8 | The `UNPOSTED` device, wired to the **phase boundary**, not to missing data: `UNPOSTED — graph-backed; not in this build` | §5.1. This is the deliverable that makes §4 legible |
| 9 | The transcript: append-only, in memory, **never persisted** — D1 stores nothing in browser storage — headed by the artifact audit rows (`connect-src` read from the live `<meta>`, request count, the two WASM imports, artifact SHA-256) | `71` §3.4, `41` §3.7, `34` §7.5, `71` §3.6 X0.3–X0.5. Adopted from 04 |
| 10 | The finder's `Ctrl+K` overlay with a **real focus trap** and the rest of the sheet `inert`, or `aria-modal` removed. Not both as they are today | §2.7(2) |

### 6.2 Exit criteria for the slice

Five are `71` §3.6's, unchanged, because the slice must not weaken them. Five are new and specific
to this shape.

| # | Criterion | Gate |
|---|---|---|
| X0.1 | Cold load → `Ctrl+K` armed, P95 ≤ 350 ms | wall-clock, nightly |
| X0.2 | Keystroke → re-ranked results painted, P95 ≤ 16.7 ms (B5) | work counters every PR |
| X0.3 | Artifact ≤ 2.5 MB; WASM core ≤ 500 KB | size gate, every PR |
| X0.8 | The shipped artifact's CSP contains `connect-src 'none'`, asserted against the final bytes | `xtask assemble` |
| X0.9 | No network request in a 30-minute scripted session, verified by a proxy that fails on any connection attempt | e2e, nightly |
| **X58.1** | The fact column is **one** tab stop. No cell is a tab stop. `Home`, `End`, `PageUp`, `PageDown` all move the cursor | e2e, driven |
| **X58.2** | The meaning column is reachable and scrollable from the keyboard without the fact column's cursor consuming the arrow keys | e2e, driven |
| **X58.3** | At every width in 700–1099px the meaning column renders inline and `factBody.clientHeight > 0`. Asserted at 1440, 1280, 1100, 1024, 900, 860, 859, 800, 700 | e2e, driven at nine widths |
| **X58.4** | `▸` occurs at most once in the rendered sheet, and only as selection | DOM `TreeWalker`, e2e |
| **X58.5** | Zero hex literals, zero px font-sizes, zero durations outside `tokens.css`; the three reserved colours resolve only inside `51` §3.3's allowlisted selectors, checked on the **computed cascade** rather than by grep | CI, `tokens/no-raw-hex` + `tokens/reserved-colour` |

### 6.3 What the slice deliberately does not contain

Per `71` §3.4, and stated so that a reasonable person asking for one of these gets "no, and here
is where it lands" rather than a slow yes: the graph; any rule; any finding; suppression; the
walkthrough; the inventory; the diagram; the second *view* (the second column is the explainer,
not a pinned view); workspace or settings persistence; context interpolation; generated ladders;
any AI. Phase 0 renders **authored** ladders from the corpus, which is what the card's
`BRING-UP ORDER` is.

**And one thing that is not in `71` §3.4 but belongs here:** no concept file is a codebase. All
five are study apparatus. 01 crashes on a documented keystroke, 02's `esc()` corrupts the copy
path in attribute position, 04's responsive collapse is one line of cascade order, 05's fact
column computes to zero height below 860px. Extending any of them is how those defects reach the
product.

---

## 7. Failure modes

| # | Failure | What it looks like | What you will wrongly blame | The fix |
|---|---|---|---|---|
| 1 | The meaning column is given a job of its own | It acquires a scroll position, then a filter, then a tab | "the explainer needs more room" | `52`'s governing rule, stated at the top of that document: *a view that holds state the others cannot see has become a second application.* And `52` §4.1 — the explainer *"has no independent subject; it always explains the thing you are looking at"* |
| 2 | The `UNPOSTED` device is wired to missing *data* rather than to the phase boundary | Every partially-filled node reads UNPOSTED and the device becomes noise the user filters out mentally | "the honesty device is too loud" | §5.1, §6.1 item 8. `UNPOSTED` means *this projection does not exist in this build*. A node with an empty field is posted, with the field absent |
| 3 | The fact column is given prose | It duplicates the meaning column, badly and truncated | "the ledger is redundant" | §10 disagreement 5. The fact column carries structure — id, node, severity bar, state, confidence tab, risk mark. Prose lives right, once |
| 4 | The two columns re-render together on every cursor move | 5 ms at 454 nodes, linear, so 2,000 rows is unusable | "the ledger is slow" | Keyed reconciliation, and the meaning column is the only thing a cursor move may repaint |
| 5 | The list component is written per view | Four different roving implementations, three of them wrong, and §2.7(1) recurs inside the product | "keyboard support is hard" | §6.1 item 3. One component, under ADR-0019's 800-line cap, so the 801st line is a design conversation |
| 6 | `aria-modal="true"` shipped without `inert` on the rest of the sheet | Screen-reader users lose the legend; sighted keyboard users tab behind the scrim | "ARIA is inconsistent" | §2.7(2). One of the two must go, and the trap is the one to keep |
| 7 | The diagram is built before layout | Five files' worth of hand-placed rectangles, again, and a band that prints a fabricated node count beside them | "SVG is hard" | §2.7(3). `56` §3 specifies the algorithm; `71` §7.5 costs it at 2.5–4 solo weeks. Until it exists, the diagram is an SVG export and the band says so |
| 8 | The transcript is persisted "so it survives a reload" | `localStorage` in D1 — a storage surface in an artifact whose claim is that it has none | "it is only local" | `71` §3.4, `43` §2.1. In memory, and the export is an explicit user action into a file they read first |
| 9 | The offline surface acquires a badge | A shield, a lock, a tick, a trust score — and then `--safe` for "offline" | "users need reassurance" | §1.2. `--safe` means read-only, forever (`51` §1 R1). The reassurance is a hairline table and a hash |
| 10 | Someone proposes a seventh view for something the ledger cannot fit | An overflow menu appears, then a settings screen | "we just need one more tab" | M10, `52` §9.5. It is a mode, a layer, a diagram layer, an inventory kind or a rule pack. If it is genuinely none of those, the design has a real problem and the menu is hiding it |
| 11 | The split is quietly reintroduced beside the meaning column | Three columns at 1280px is 400px each, below the card's own column width, and the type stops working | "widescreens have the room" | `52` §2.3. Two panes, never three. The ledger already spent the second one; §5.3 says so out loud |
| 12 | Phase 1 lands and the fact column is left as it was | Six views' worth of graph data rendered through a component built for corpus rows | "the ledger does not scale to the graph" | The fact column is the six views' bodies. Phase 1 adds implementations of `primary`/`resolve`/`select_at`, not a new column |

---

## 8. Open decisions

**DECISION — is the picture the primary surface, or one of six views?** §5.3 states the case
plainly: if *"inventory diagramming"* means the diagram is the organising principle, concept 03
is the right direction and §5.1 is wrong. **RECOMMENDATION — take the ledger and re-open this at
phase 2's exit, when there is a real estate to draw.** The evidence for deferring is 03's own
measurement — with the picture permanent, 87px and zero answer rows sit above the fold on the
owner's 1280×800 target — and `52` §3.6.1's already-accepted position that for anything
nameable, `Ctrl+K` and the table are faster.

**DECISION — reverse ADR-0006 §4 and restore phase 4 as a real view?** Cost: +6–10 solo weeks,
and it un-books the 5–9 weeks ADR-0006 recorded by name. **RECOMMENDATION — do not reverse it
now. Reverse it when X2's exit criteria are met and a pilot has an estate worth drawing.** `41`
§10 open decision 5 offers the scope reduction that makes the reversal cheap when it comes:
drag-only positioning first, layered auto-layout later, which `56` §12 already recommends taking.

**DECISION — does the meaning column ever pin to something other than the fact column's
cursor?** The `52` §4.2(b) drawer is pinnable in the specification. **RECOMMENDATION — no. A pin
is state nobody remembers setting, and the ledger's entire proposition is that the right column
is *always* about the left cursor.** If a user needs a fixed reference beside a moving one, that
is the split, and the split is spent.

**DECISION — the transcript's granularity.** One entry per user intention, or one per state
change? **RECOMMENDATION — one per user intention, matching `41` §3.7's rule for the WASM
boundary — *"one crossing per user intention, never one per element"* — so the transcript and the
opcode log have the same shape and can be checked against each other.**

**Open, not decided — how the fact column renders a kind with twelve columns at 702px.** The
ledger's honest answer is that the table stays narrow and the row is fully posted on the right,
which is arguably its best inventory argument rather than its worst. It has not been drawn. It
needs a wide-kind fixture and a pass against `52` §3.7's generated column set.

**Open, not decided — whether `52` §9.6's 14-fact scent budget survives a permanent second
column.** The meaning column adds a posting reference and a depth tab to every screen. Those may
be facts about the *selection* rather than about the header, in which case the budget is
untouched; or they may be two more facts, in which case *"which fact does this replace"* has to
be answered twice.

---

## 9. Sources consulted

- `.context/owner-brief.md` — §6.1 (*"zero setup, zero data entry, zero trust required"*), §6.3
  (paste as the primary on-ramp, never an empty form), §6.4 (**DECISION —** inventory and the
  intent model are the same schema; *"the inventory has opinions… Facts that argue back"*), §6.5
  (the diagram scoped as a design tool, not a source of truth, and the instruction to mark parsed
  nodes with their age).
- `.context/design-language.md` — the palette by usage frequency, the two families and five faces,
  the margin tab, the 4px left accent bar (*"never a box, never an icon, never a rounded corner"*),
  the one-line imperative, two-column tables with horizontal hairlines only, continuation
  backslashes, ordinals as content, and the forbidden list.
- `.context/conventions.md` — the ten hard invariants, the risk enum and its amendment under
  ADR-0011, the identifier scheme, and the instruction to record objections under
  `## Disagreements` rather than deviate silently.
- `.context/field-card-srx-ipsec.txt` — the worked topology every concept's fixture derives from.
- `corpus/commands/junos-srx-ipsec.yaml` — `junos-srx/ipsec.sa.show` (the `answers`, `aka`,
  `read_field`, `output_fields`, `next_if_bad` and three depths that carry goal (a) on their own),
  `junos-srx/ike.proposal.auth-method.set` (`risk: Disruptive` on a `set` line, post-ADR-0011),
  and the header stating that nothing in the file has been run on a box by its author.
- `corpus/rules/ipsec-junos-srx.yaml` — `ipsec.pfs.absent`, `zone.host-inbound.ike-missing`,
  `tunnel.st0.zone-unbound`, `mtu.mss-clamp.absent`, used as the M1/M2 demonstration pair.
- `docs/50-design/51-design-tokens.md` — §1 (R1 the reservation rule, R2 no meaning in colour
  alone, R3 one channel one owner), §3.3 (the two CI checks), §4.2 (the channel assignment), §5
  (dark derived, not inverted), §6 (forced colours), §7 (the two families, the tuned scale, line
  height as a length, letterspaced uppercase never typed), §8 (the 4px-based space scale and
  `--row-min`), §9 (three rule weights and the reservation of dashed and dotted), §10 (`--radius: 0`
  and the lozenge argument), §11 (`--shadow: none`, no floating panels, no tooltip), §12 (no
  animation).
- `docs/50-design/52-information-architecture.md` — §1.1 (four renderers, one controller, one
  corpus surface, one layer), §2.1 (five shells rejected by name), §2.2 (the sheet and the ~210px
  budget), §2.3 (two panes, the second pinned, and the R35/ADR-0025 amendment that makes it the
  inspector), §2.4 (responsive collapse), §3.1 (the three-function view contract), §3.2, §3.5,
  §3.6, §3.7, §3.8 (the connection matrix and its two governing rules), §4 (the explainer's three
  placements and the fact that it never fetches), §5.1–§5.2 (selection, facets, and the two-tier
  narrowing), §9.3–§9.6 (the view band, the ribbon, what is forbidden, the scent budget).
- `docs/50-design/53-interaction-and-keyboard.md` — §2.2 (no modes), §8.3 (the roving list
  contract and the combobox exception), §11.4 (target size), and the governing rule about
  bindings with no visible affordance.
- `docs/50-design/54-component-catalog.md` — §2.5 (the roving contract stated once), §6 (the
  legend's placement rule and the deleted swatch), §18 (the 420px inspector), §22 (the closed
  glyph set).
- `docs/50-design/55-accessibility.md` — §1 (the conformance target as qualified by ADR-0026),
  §2 (the 4.5:1 threshold applying to every glyph, and §2.5 F1 forbidding `--hairline` as a
  diagram boundary), §4.5 (the Outline as the diagram's keyboard and screen-reader interface).
- `docs/50-design/56-diagram-view.md` — §0 (the governing rule), §1.2 (the two claims the picture
  may never make), §3 (the layout algorithm none of the five implemented), §7 (the bijection),
  §12 (the drag-first build order this document adopts by reference).
- `docs/70-ops/71-roadmap.md` — §2 (every effort figure in §4), §3.3 (the phase-0 UI line item
  §6.1 spends), §3.4 (what is deliberately not in phase 0), §3.6 (X0.1–X0.11), §3.7 (the
  instrument that cannot exist), §4.7, §5.7, §6.6, §7.5 (per-phase effort).
- `docs/40-stack/41-technology-choices.md` §3.7 (the ten opcodes and the two-entry import
  section), §4.3, §10 open decision 5.
- `docs/40-stack/44-performance-budgets.md` §3 (B5's 16.7 ms P95 and 33.4 ms hard fail; B12's 500
  nodes in 160 ms; B13's 8 ms pan frame), §4.7 (the 2,000-element ceiling).
- `docs/30-security/34-browser-hardening.md` §2.2 (the literal mode-A CSP), §2.3 (why
  `form-action` is not covered by `connect-src`), §5.6 (the closed SVG tag set), §14 (the
  import-section check).
- `docs/60-content/61-command-corpus-spec.md` §3, §4.6; `docs/60-content/63-rulepack-spec.md`
  §2–§4, §10.
- `docs/90-decisions/` — ADR-0006, ADR-0008, ADR-0009, ADR-0011, ADR-0019, ADR-0024,
  ADR-0025 (R35 the single second surface, R36 the ~210px furniture), ADR-0026 (R37, the
  qualified AA claim and the focus-visible fix), ADR-0027 (the verification stamp).
- `docs/80-review/80-reconciliation.md` — R35, R36, R37 (the recorded SC 2.4.7 failure the
  concepts were measured against).
- The five rendered concepts and their adversarial reviews: `design/concepts/01-workbench.html`,
  `02-runbook.html`, `03-canvas.html`, `04-console.html`, `05-ledger.html`. Every measurement
  quoted in §2 and §3 comes from those reviews, which were produced by driving the files in
  Chromium under Playwright.

---

## 10. Disagreements

**1. The two goals cannot both be v1, and no UI direction changes that.** The owner named
teaching and inventory-with-diagramming as the two goals. Both require the graph. The minimum
scope that satisfies both is phases 0+1+2 — 50–72 solo weeks against v1's 12–18, roughly 4× at
both ends — and 64–94 if *diagramming* means a real diagram view rather than an SVG export. `83`
§12.5 implies a further 1.5–1.6× on those figures, and `71` §2's headline omits 20–30
person-weeks of corpus authoring. I do not believe the owner has been told this in one sentence,
so here it is: **the two goals as stated are a four-times multiplication of the thing currently
scheduled to ship, and choosing a UI direction does not reduce it by a week.** §5 chooses the
direction that makes the gap visible and cheap to carry; it cannot close it.

**2. The strongest case for keeping ADR-0006 and shipping the finder first regardless of
anything in this study.** I do not take this position, and it deserves its best form because it
may be right. `84` §3.2 found that the wedge's five nearest relatives all stopped at the wedge —
the finder is not a stepping stone to the graph, it is where comparable projects ended, and
building the graph first is therefore betting against the only base rate available. `71` §12.1's
kill signal — *fewer than half the pilot group open the finder unprompted in week 3* — tests the
entire adoption thesis on an artifact that costs a fortnight rather than a year; going to phase 2
first means reaching the first falsification of the central bet at about the same time the free
alternative has had three more years of improvement (`84` §8). Invariant 1 forbids telemetry
permanently, so there is no instrument that recovers a wrong sequencing decision later — the only
instrument is a shipped artifact in a pilot's hands, and phase 0 is the cheapest one that exists.
And the study's own evidence supports the sequence: §2.7(3) found that five concepts drew five
pictures of a diagram and none drew a diagram, which is what a study should look like when the
thing being designed is 38–54 solo weeks away from existing. **The honest version of this
argument is that a UI study conducted before the graph exists can only tell you which shell to
build, and §5 answers exactly that question and no more.** I have written §5 so that taking this
position costs nothing: the recommended direction ships whole at phase 0.

**3. "Blocking" must not become panels.** If the owner's admiration for Termix's layout means
*fixed regions with stable addresses*, the sheet already delivers it. If it means *panels*, that
is the dashboard-of-panels shell `52` §2.1 rejects by name — six panels at one sixth the density
— on the grounds that *"nothing in this product is glanceable: a finding you glance at is a
finding you did not read."* I believe the owner means the former, and I am recording the
distinction rather than assuming it, because concept 01 shows what happens when a fixed region is
given a permanent job: 38% of a 1280px screen, twice the cost `52` §2.1 used to reject a left
rail, for content that is one keystroke away.

**4. "Functionality addable at any moment" is right about modules and wrong about views.** I
disagree with the unqualified form of the requirement. Rules, packs, corpus entries, node kinds,
inventory kinds, diagram layers, explainer subjects and view *modes* are all addable at any
moment, by design, and §6.1 keeps every one of those seams open. **Views are not**, and making
them easy to add would be making the wrong thing easy: `52` §9.5 states that six views fit and
*"if a seventh is ever added, this design has a real problem and an overflow menu would be
hiding it."* The precedent is already set twice — `verify(diff(graph))` became a mode,
`explain(node, depth)` became a layer. A direction that routed around M10 would satisfy the
letter of the owner's request and destroy the property that makes `⌥1`–`⌥6` muscle memory.

**5. I disagree with concept 05's reviewer on one point, and it matters for §5.** The review
finds that 336 of the fact row's 499 characters (67%) appear verbatim in the meaning column and
calls it *"a direction-level self-refutation."* It is not. The duplication is the rule title,
`symptom_if_mismatched` and `acceptable_when` printed **truncated** on the left by two
`.slice()` calls and in full on the right. That is a content-assignment defect with a one-line
cause: the fact column was given prose. The fact column's job is structure — rule id, node,
severity bar, finding state, confidence margin tab, risk mark — and prose belongs on the right,
once. Fix the assignment and the 67% goes to near zero without touching the layout. I would not
recommend this direction if I thought the reviewer's reading were correct, so the disagreement is
load-bearing and is recorded here rather than argued in §5.

**6. The study cannot answer the question the owner most wants answered about goal (b).** Five
concepts were rendered and none implements diagram layout (§2.7(3)). Every statement in §3 about
a direction's fitness for *diagramming* is a statement about how it hands off to the picture, not
about the picture. If the owner reads §5 as a decision about the diagram, it is not one; §8's
first two open decisions are.

**7. Three of five thesis panels made load-bearing claims their own artifact refutes.** 01's
*"watch the canvas take the whole width back"* loses 19% of canvas area; its *"every region
regrades together"* reaches one block; its estate column is not `52` §2.3's pinned surface. 02
predicts its cost as nested scroll and an enormous middle when the measured cost is 1.1–2.6 s per
finder keystroke, and never mentions that its diagram section does not render the graph. 03
states the docked table's cost as *"under 300px, about eight findings rows"* against a measured
87px and zero rows. All three panels are otherwise unusually honest — 01 names its own empty
column, 03 names its phase gap and its missing kinds, 05 names the cost it cannot recover — which
is exactly why the inaccurate sentences are a problem: the owner would have chosen on them. **A
thesis panel is a claim about an artifact, and a claim about an artifact should be measured
before it is written.** Whatever direction is built, its self-descriptions belong under the same
gates as its CSP.
