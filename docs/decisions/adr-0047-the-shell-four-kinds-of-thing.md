# ADR-0047 — The shell: four kinds of thing, and an estate that spans organisations

**Status:** Accepted, 2026-09-16
**Owner direction, 2026-09-16:** on the screens set of 2026-09-15: *"I'm wanting to have the ability
to map out an entire enterprise with this tool, so it being a header is just not possible … these
make the website look so small … think of lucid chart, it has a lot of power with little on screen,
but on the flip side we have basically a UI for a database."* On the five boards drawn from the
vocabulary below: *"Those look great."* On firmware: *"I would think devices would pull from fathom.
Maybe throw away user and passwords or keys? … as simple as possible while also being secure."*
**Pictures:** https://claude.ai/artifact/GkXzzMe3JG6SQAaXke9C4p — sources and renders in
`design/shell/`.
**Amends:** `docs/UI-SPEC.md` "The shape" (the masthead row, the rail, the camera); ADR-0046 §1
(the masthead) and §4 (the camera's stops). **Retires** the 2026-09-11 shell board, the eight
direction boards and the first passes (`docs/archive/design-retired-2026-09-16/`).

---

## 1. Four kinds of thing, and nothing else gets a name

The owner's worry was *"so many views and modes"*. The answer is a vocabulary of four, and every
screen is made only of these:

- **Places.** Where you go. Two: **Racks**, the drawing, and **Inventory**, the lists. Home is what
  you land on.
- **Stops.** How far in the camera is. One drawing, seven stops: **estate → site → building →
  closet → rack → faceplate → inside**. *Inside* is a server opened to its VMs or a chassis to its
  cards, the approved Hypervisor and Firewall boards, now named as a stop. Never a page change.
- **Lenses.** What is drawn on top of the same boxes. One at a time: **Cables · Links · Routing ·
  Power · Owner**. A lens never moves a box and never hides one; it changes the marks and the
  colours, and in Inventory it changes which columns show. Routing at the estate stop is the WAN;
  routing at the rack stop is the gateways on the ports.
- **Surfaces.** Opened on top of the drawing and closed again, without moving: the editor, search,
  the patching table, the walkthrough.

The owner's list maps onto them: *TCP/IP routing* is the routing lens, with the walkthrough lighting
one path through it; *VMs inside a box* is the inside stop; *physical racks* is the rack stop under
Cables; *site location* is the site and estate stops; *freeform drag and drop* is the patching table.

## 2. The bar

One row, 44px, the 3px rule beneath, and nothing else above the drawing. Left to right: **Fathom**;
**Racks · Inventory** with the current one marked; **the path** (`Northwind › HQ › Building A ›
IDF-2`; click any part and the tree opens beneath it); **the lens**, five words with one lit; then
**search**, **who else is here**, **Undo · Redo**, **zoom**, **you**. Gone on purpose: the cable-kind
toggles and the "colour ports by" buttons, because a lens is both. As drawn: search shrinks to its
magnifier when the path is long, and the zoom number is a scale.

## 3. Under the bar

- **The drawing is the screen.** The rail folds to a 28px strip of marks and opens on click.
- **The editor is a surface.** It slides in when something is selected and goes when you click away.
  It is the same component as the inventory page (ADR-0046 §2).
- **One kind of pop-over.** A flat hairline box, square corners, no shadow, opened by a click, closed
  by clicking away or Esc, never more than one level. The tree, the account menu, the far-end picker,
  the colour picker, the release picker, and right-click on anything: open in inventory, pull into
  the patching table, add a note, open the config drawer, copy name. Hover only ever shows a small
  label after a pause.

## 4. The estate stop, and how scope is held

An enterprise has many sites, they interconnect, and sometimes with other organisations; the
organisation cannot be one word in a header. Five ways to hold that were put to the owner (the tree
as NetBox does it; the map as Meraki does it; pages as Lucidchart does it; the graph as Auvik does
it; scope as a filter as Datadog does it). **The decision is the mix, as drawn:**

- **The tree** in the path's pop-over for scope and permission, because the server already grants
  over a scope tree of any depth.
- **The graph** as the top stop: sites placed by hand, never auto-laid-out (D5), and the links between
  them drawn as **counted bundles, never single lines**, the same rule the building uses for risers,
  with the carrier and circuit IDs on the label.
- **The filter** across everything: a saved list is a saved filter (ADR-0046 §2).
- **A map image** as an optional background at the estate stop, placed by hand, never required — the
  same rule as the floor plan, with the same open question (currency, export, size).
- **A link to another organisation goes through a portal**, the same rule as a cable between closets.
  You see the far side's name and nothing you are not allowed to read.

## 5. Optics

**A cage takes an optic before it takes a cable.** Drag cage to cage and on release you say what is
between them: a DAC, one cable with both ends fixed; or two optics and a fibre pair, three parts each
with its own record. The default is the last answer given on this design. **The check follows the
optic**, not the cage: an SFP+ cage holding a copper optic takes copper.

The schema already has `PhysicalPort.transceiver`, but its type `Transceiver` is a stub with no
fields (*"shape stated nowhere read"*). Giving it a shape — the kind, the media it presents, and
whether it is a DAC — is schema work and comes first, by `CLAUDE.md` rule 3.

## 6. Tracked changes

A maintenance record (ADR-0046 §7) lists the changes it covered and has one button, **Show these
changes**, that shows them on the drawing the way a document shows tracked changes: added is solid,
removed is faded and struck, changed shows old and new, and everything outside the set steps back to
0.28. The trail already holds every change, so this is a view, not a second record. **Now:** the
record and the button. **Later:** *"I have planned this"* is the planned status on the device (D6),
and notifying tags, groups and locations waits for groups (admin design §3.7), which are designed
and not built.

## 7. Firmware stays as built

The owner reaffirmed ADR-0045 in their own words: the device pulls from Fathom, with a throwaway
credential. That is the single-use fetch URL that dies after one fetch or fifteen minutes, hashed at
rest, with no username, password or key in it and no device credential held by Fathom.

## 8. What was retired

To `docs/archive/design-retired-2026-09-16/`, not deleted: the 2026-09-11 shell board (open rail,
old masthead), the eight direction boards, the first passes carrying the six-tab strip (Inventory,
Rack, Vault, ConfigChecker), the withdrawn "Listed" proposal, and the July–August 2026 concept,
diagram, prototype and walkthrough pictures of the retired client. The 2026-09-11 boards that draw
the drawing's details stay (Legend, Faceplate, Crossings, Motion, Hypervisor, Firewall, Config,
Building); their masthead is superseded, their drawing stands. The screens set of 2026-09-15 stays
for its surfaces; its bar is superseded (`design/proposals/screens/README.md`).

## 9. Raised by the owner or the drawing, not decided here

- **A known link with unknown ends.** *"An expected connection but no port or anything connected."*
  Proposal: draw it in the proposed rule style (`--rule-style-proposed`, dashed), ending at the
  edge of the site, rack or device box instead of a port, with its count; list it in Inventory as a
  gap ("link to Denver NOC · ends not set"); as each end is set it snaps to the port, and it goes
  solid when both are. A suggestion until the owner says so.
- **Long names.** Proposal: never shrink type; clip to the room the box has at that stop, with the
  ellipsis in the middle so the distinguishing end survives; the full name on hover after a pause,
  always complete in the editor and in Inventory, and *Copy name* on right-click. Fewer characters
  show at the closet stop, more at the rack stop, all of them at the faceplate.
- **Name and model in a device box.** The owner asked whether to swap them since the right side has
  room. Proposal: keep the name on the left, because eyes scan the left edge down a rack, and give
  the name up to two thirds of the row, with the model right-aligned and the first to shrink.
- **Side-by-side lenses.** The Lenses board shows two to make its point; the product shows one at a
  time. Whether a compare mode exists is open.
- **A plate pushed out while a lead is in hand** from one of its ports (from the screens set).
- **A maintenance record spanning scopes:** whose chain seals the outcome (OPEN-QUESTIONS D10).
