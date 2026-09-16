# The shell — brief for five boards, 2026-09-16

A proposal, not a decision. The owner asked for pictures of the vocabulary agreed in conversation on
2026-09-16, after the screens set of 2026-09-15 (`design/proposals/screens/`). Nothing here is in
`docs/UI-SPEC.md` yet; it goes there only if the owner approves these boards.

**Five boards, no animation.** Main (the shell), Estate, Lenses, Optics, Changes. Do not redraw
anything the two earlier sets already show: the patching table, undo, maintenance record, people,
operator console, walkthrough, inventory, home, and *inside a box* (the approved `Hypervisor` and
`Firewall` boards already open a box) are done.

## The vocabulary — four kinds of thing, nothing else gets a name

- **Places.** Where you go. Two: **Racks** (the drawing) and **Inventory** (the lists). Home is what
  you land on.
- **Stops.** How far in the camera is. One drawing; the wheel moves through seven stops:
  **estate → site → building → closet → rack → faceplate → inside**. Never a page change.
- **Lenses.** What is drawn on top of the same boxes. One at a time: **Cables · Links · Routing ·
  Power · Owner**. A lens never moves a box and never hides one; it changes the marks and the
  colours. In Inventory it changes which columns show.
- **Surfaces.** Things opened on top of the drawing and closed again, without moving: the editor,
  search, the patching table, the walkthrough.

## The bar — one row, 44px, 3px ink rule beneath, nothing else above the drawing

Left to right, with a 1px hairline 24px tall between groups:

1. **FATHOM** — 15px, 700, 0.16em, uppercase.
2. **Racks · Inventory** — 11px, 0.14em, uppercase labels. The current one is 700 with a 4px ink
   bottom border spanning the bar's height. On Racks boards, Racks is current.
3. **The path** — 11px: `Northwind › HQ › Building A › IDF-2`, separators muted `&rsaquo;`, the
   last part ink 700, the rest muted. Clicking any part opens **the tree** (a popover) beneath it.
4. **The lens** — five words in a row of bordered boxes, 11px, `2px 8px` padding, 1px hairline
   border; the lit one has an ink background and page-coloured text. Order: Cables, Links, Routing,
   Power, Owner.
5. Then, right-aligned: **search** (a hairline-bordered box ~180px with an 11px magnifier SVG and
   muted "Search" plus mono "Ctrl K" at the right edge), **who else is here** (name chips, 1px
   hairline border, `2px 8px`), **Undo · Redo** (two ink-bordered chips, the words only), **zoom**
   (`−  100%  +`, the sign buttons 20×20 hairline boxes, the number mono), and **you** (a 24×24 ink
   square with "RK" in 10px page-coloured text).

Gone from the old masthead, on purpose: the cable-kind toggles and the "colour ports by" buttons —
a lens is both. Measure the row; if it will not fit 1440, search collapses to the magnifier alone
before anything else gives.

## Under the bar

- **The drawing takes the whole width.** No open left rail. On the left edge a 28px strip on
  surface with a hairline right border carries, top to bottom: a small "›" handle (the rail opens on
  click) and three 16×16 marks stacked with 12px gaps — a rack outline, a plug outline, a
  building outline — each just a 1px ink line drawing. A hover label would name them; draw none.
- **The editor is closed** unless something is selected. Where a board has nothing selected, there
  is no right panel at all.
- **Popovers are one kind:** a box with a 1px hairline border, surface-2 background, square corners,
  no shadow, 6px 0 padding, rows of 12px text with `5px 12px` padding, the current row 700.
  Opened by a click, closed by clicking away. Never more than one level.
- **A caption strip at the bottom**, 34px, surface-2, hairline top border: on the left the board's
  sentence in 12px; on the right, muted 11px: "Every name, address, count and time on this board is
  a sample."

## The format — each file is one self-contained Design Component

```
<!doctype html>
<html><head><meta charset="utf-8"><script src="./support.js"></script></head>
<body><x-dc><helmet><style> body{margin:0} a{color:#14171A} a:hover{color:#5C6772} *{box-sizing:border-box} /* classes here */ </style></helmet>
<div style="width: 1440px; height: 900px; background: #FFFFFF; ...">…</div>
</x-dc></body></html>
```

Keep the `<script src="./support.js"></script>` line exactly. No `<script data-dc-script>` at all.
Inline styles on elements; flex and grid with gap for every sibling group; close every element;
quote every attribute; ASCII only — every non-ASCII glyph is an entity (`&middot;` `&rsaquo;`
`&mdash;` `&rarr;` `&times;` `&ndash;`); no emoji; any icon is inline SVG. Root elements exactly
1440×900 (Lenses and Optics: 1440×620), each with an explicit background. No `@keyframes`, no
`transition`, no `animation` on these boards.

## The language — not negotiable

Only these colours: ink `#14171A`, muted `#5C6772`, surface `#F2F4F6`, hairline `#D2D7DD`, page
`#FFFFFF`, surface-2 `#FAFBFC`; risk washes caution `#A8571B` on `#FBF3EA`, safe `#1F6F4A` on
`#EEF5F1`, danger `#8C2F2F` on `#F8EFEF`. A risk colour appears ONLY as a bordered wash with words
inside it — never bare coloured text, never a line, never a fill without a border. Sheath colours
from `design/tokens.css` (`--sheath-*`) appear only as cable strokes, the port a cable fills, or a
swatch. Zero radius, no shadows, 1px hairlines, the 3px bar rule. Type: Liberation Sans 13px/20px
body; DejaVu Sans Mono 12.5px for values, tabular numerals; labels 10px, 0.10em, uppercase, muted.
Selected row: surface background with a 4px ink left border. Buttons: 1px ink border, `5px 0`
padding, centred 12px text; a secondary button uses the hairline border and muted text. Hatch for
free rack units as `design/rebuild/Main.dc.html` draws it. Everything off a lit path sits at
opacity 0.28.

Glyphs: RJ45 (latch notch), SFP+ (cage with a bail, one horizontal rule), QSFP+ (wide cage, three
vertical rules, no bail, 40×13), LC (two ferrules), C14 (hex inlet). Lift them from
`design/proposals/screens/Patching.dc.html`, which already has them as `<defs>`.

## The sample estate — every board agrees with this

Organisation **Northwind Logistics**; the viewer is **Rowan K.**, chip **RK**, a steward. In scope:
four closets, 9 racks, 60 devices. Sites: **HQ** (Building A: MDF — ground, 2 racks, 11 devices;
IDF-2, 2 racks, 24 devices; IDF-3, 1 rack, 6 devices) and **Denver NOC** (4 racks, 19 devices). One
closet in the organisation is outside the viewer's scope and is not listed. Another organisation the
viewer can read: **Acme Dental**. People in the room: Jordan T., Maria P.

Rack **A-04**, IDF-2, 42U: hq-fw-01 SRX340 U40–41 · core-01 EX4300-48P U38 · core-02 EX4300-48P
U37 · patch-01 24-port panel U35 · acc-01 EX2300-48P U34 · acc-02 EX2300-48P U33 · fibre-01 12-port
LC panel U30 · free U20–29 · vm-host-01 4U server U16–19 · vm-host-02 4U server U12–15 · pdu-a04 U3.
Rack **A-05**, IDF-2, 24U, landlord's, empty. core-01 runs Junos 21.4R3-S5 with 23.4R2 staged;
mgmt 10.10.0.2; irb.20 is 10.10.20.1/24 (VLAN 20, staff); hq-fw-01 is the gateway out, 10.10.0.1.

Links between sites: HQ ↔ Denver NOC — MPLS via "carrier A", two circuits CKT-4471 and CKT-4472;
and one internet VPN. Denver NOC ↔ Acme Dental — one cross-connect, through a portal, because it
leaves the organisation.

## The boards

**Main.dc.html — the shell, at the closet stop.** Path `Northwind › HQ › Building A › IDF-2`,
Racks current, lens Cables lit. The drawing fills the width: racks A-04 and A-05 side by side at
about 14px per U, drawn as `design/rebuild/Main.dc.html` draws a rack (rails, U numbers, hatched
free units), the devices above as boxes with their names and a few ports, three or four cables with
sheath colours sagging between them. Nothing selected, so no right panel. A right-click popover is
open on core-01 with rows: "Open in inventory", "Pull into the patching table", "Add a note",
"Open the config drawer", "Copy name". The caption sentence: "The drawing is the screen. Panels
fold away; the bar is the only thing that stays."

**Estate.dc.html — the estate stop.** Path `Northwind` alone, Racks current, lens Cables lit, and
**the tree popover open** under the path: Northwind › HQ › Building A › MDF — ground / IDF-2 (A-04,
A-05) / IDF-3; Denver NOC; then a muted row "1 closet not in your scope"; then a hairline and
"Acme Dental" as another organisation, muted, with "read" beside it. The drawing: three boxes placed
by hand on the page — **HQ** and **Denver NOC** as site boxes (name at 700, a mono line "3 closets ·
5 racks · 41 devices" and "1 closet · 4 racks · 19 devices"), and **Acme Dental** drawn as a portal
the way `design/rebuild/Main.dc.html` draws one (a bordered box with the name and "another
organisation"). Between them, **bundles, never single lines**, lifted from
`design/rebuild/Building.dc.html`: HQ–Denver as one thick counted run labelled "MPLS · carrier A ·
2 circuits" with the circuit IDs in mono beneath, plus a thinner one labelled "internet VPN · 1";
Denver–Acme a run labelled "cross-connect · 1" ending at the portal. An optional background is not
drawn; a muted caption in the corner of the drawing says "a map image can sit behind this, placed
by hand, never required". Caption sentence: "Sites placed by hand, links drawn between them. The
tree is how you move; the lens is what you see."

**Lenses.dc.html — 1440×620, the same rack twice.** Two panes side by side, each ~690px wide with a
hairline between, and one shared bar above at the top (path `… › IDF-2 › A-04`, Racks current) but
with the lens shown lit differently in each pane's own small header: left "Cables", right
"Routing". Both panes draw U40–U30 of A-04 with **identical geometry** — same boxes, same
positions, same sizes. Left: cables drawn with sheath colours, ports filled where cabled. Right:
cables at opacity 0.28, and instead mono marks on the boxes: core-01 "irb.20 · 10.10.20.1/24",
hq-fw-01 "gateway · 10.10.0.1 · default route out", acc-01 and acc-02 "vlan 20 · via core-01", and
ports coloured by subnet with a two-row legend (10.10.20.0/24 staff, 10.10.30.0/24 servers) using
two sheath colours as swatches. Caption sentence: "Same boxes, same places. Only the marks changed."
Do not repeat the composition of `design/rebuild/DirectionA.dc.html` (read it once to avoid it).

**Optics.dc.html — 1440×620, cage to cage.** Faceplate stop: core-01's four SFP+ cages xe-0/0/0–3
on the left, vm-host-01's two SFP+ cages on the right, drawn large (each cage ~72×24) with the SFP+
glyph. xe-0/0/2 holds an optic already: draw a small ink block inside the cage labelled "SR · LC" and
a fibre pair leaving it. xe-0/0/0 is empty: the cage alone, muted. A lead is drawn from xe-0/0/1 to
vm-host-01's first cage, straight and at 0.28, and **the release popover is open at the drop
point** titled "What is between them?" with two rows: "DAC · 3 m · one cable, both ends fixed" (700,
marked as the default with "last used") and "Two optics and a fibre pair · SFP+ SR · LC both ends",
and a hairline-separated third line, muted: "The check follows the optic: a cage holding a copper
optic takes copper." Caption sentence: "A cage takes an optic before it takes a cable. Drag cage to
cage and say what is between them."

**Changes.dc.html — tracked changes on the drawing.** Path `… › IDF-2 › A-04`, Racks current, lens
Cables. The editor is open on the right (316px, surface-2) showing the maintenance record "Upgrade
to Junos 23.4R2" as `design/proposals/screens/Maintenance.dc.html` draws its right column, with a
button "Show these changes" drawn pressed (ink background, page text) and, beneath it, "Changes it
covered · 3" as three rows each with an 8×8 ink square: "firmware core-01 · 21.4R3-S5 → 23.4R2",
"cabled core-01 xe-0/0/2 → fibre-01 p3", "uncabled core-01 xe-0/0/3 → fibre-01 p4". The drawing
(U40–U30 of A-04) shows them the way a document shows tracked changes: the added cable drawn solid
with a small ink chip "+ added" at its midpoint; the removed cable at 0.28 with a 1px ink line
struck through its midpoint and a chip "− removed"; core-01's box carries "21.4R3-S5 → 23.4R2" in
mono with the old value struck through. Everything not in the change set sits at 0.28. Caption
sentence: "Like a document's tracked changes: added is solid, removed is faded and struck, changed
shows old and new."

## Rules for the designers

Write only your named files under `design/proposals/shell/`. Do not seed, publish, or run git.
Do not read `docs/archive/`. Do not open any artifact URL. Read this brief, `design/tokens.css`,
`design/proposals/screens/Main.dc.html` (the last bar, to see what changes), and the boards this
brief names for your files. Report in under 40 lines: what you drew, where the brief was silent and
what you chose, and any question the drawing surfaced.
