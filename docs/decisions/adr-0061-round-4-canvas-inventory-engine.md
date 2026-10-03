# ADR-0061: Round 4: canvas, inventory and engine

**Status:** accepted 2026-10-02. The owner answered round 4 on the sign-off page,
https://claude.ai/artifact/VEBbxLMLyAjCxFyFu7B9cQ (cards `r4-*`). Amends ADR-0060's order of work
and ADR-0046's two places. Nothing below is built yet.

## Approved

1. **Order of work.** (1) admin pill, design names, three bugs (in flight); (2) the canvas looks
   right; (3) step 7 with the Lucidchart basics; (4) Inventory rework; (5) owner walkthrough;
   (6) step 8 with paste anywhere and the ports legend; (7) Checks with Why? cards; (8) maintenance
   plans; (9) Docs; (10) ADR-0060 steps 9 and 10, cable groups (#54) rebuilt on the new cable
   drawing, the rest of print and tags; (11) path trace (#46), then guided lessons.
2. **Zoom only magnifies.** It has a last stop and never changes the view: the config drawer and
   the inside view open only by right-click Open, a double-click or going to the device's
   inventory. Close in, a bundle draws its cables one by one with both ends labelled; added labels
   never overlap. This drops the faceplate and inside camera stops' click behaviour.
3. **Names** sit in the plate's blank space, drawn above cables; a plate with no room puts the name
   on a tab at the rail. A click draws a callout out with a short animation, joined by an animated
   dotted line in a colour that stands apart from hairlines (ADR-0033: the motion says what it is
   attached to).
4. **Ports** are drawn where the catalogue puts them, both rows visible; a cable leaves a port from
   its own edge. The details panel lists the ports in words; hover names one. Common devices get a
   default faceplate. Brackets on the plate belong to Learn mode.
5. **Checks** run live: a gesture that cannot work is refused with the reason and a fix; standing
   problems show as badges and in a Checks panel beside the drawing, out of the way and draggable.
   Every check is a written rule with a source (ADR-0020: no model decides).
6. **Teaching:** a Learn switch and Why? cards first, from `corpus/explainers` and
   `corpus/concepts`; lessons later. It must cope with real complexity (port roles, reth and other
   aggregate interfaces).
7. **Config paste** anywhere on the canvas, with a card saying what was read and what the gate
   destroyed, attaching to a same-named device or adding one. An import page comes later.
8. **Docs is a third place** beside Canvas and Inventory (amends ADR-0046 §1). Parts of a device's
   docs and inventory are glanceable from both Canvas and Inventory; how much is open. Uploaded
   pictures wait for a security decision (they bypass the redaction gate).
9. **Path trace first:** pick two ends; an animated trace shows every hop at layer 2 and 3 and every
   policy read, allows included, with a filter for what could block. Fathom still never says
   permitted or denied (UI-SPEC). Needs NAT and policy shapes in the schema first.

## Sent back for round 5

- **Cables:** offer several styles (dressed, hanging, schematic, and a stub that fades out and lights
  its far end), chosen per rack or design with a per-cable override.
- **Step 7's look:** the direction is right but the mockup did not look native; more ideas wanted.
- **Inventory:** neither spreadsheet nor outline. NetBox-like: easy to enter, rich, with custom
  fields, tags and notes.
- **Maintenance:** its colour must not be the warning amber; needs an interactive example covering
  address, routing, cable, rack and building moves.
- **Shelves:** drag the edges, with numbers in the panel too, but the look needs refining.

## Round 5, answered 2026-10-02

Approved:

- **Cables:** all four styles. New designs start Dressed. The style is saved in the design and set
  for the design, then a rack, then a cable, so everyone sees the same drawing.
- **Step 7:** a selected box shows small hollow squares on its edges, the same shape as a free
  port. Drag one to draw a line; click one to add a dashed "new" box and pick its kind. A flat word
  menu sits over the selection (Align, Spread, Group). Guides are dotted ink. Free dragging stays
  everywhere. On a rack, the squares sit on the free unit above and below the selected device;
  that look goes to round 6.
- **Shelves:** two small square grips (bottom for height, right for slots) add dashed units while
  dragging. The same numbers sit in the panel.
- **Inventory:** list and page side by side; the page is the canvas details panel's editor
  (ADR-0046). Amended by the owner's note: the list is a table with columns you choose, edited in
  place and built for hundreds of rows and fast keying. Fields are defined once per kind for the
  organisation; any member may add a field, shared with everyone unless they mark it private.
  Private fields need a security review before they are built.

Sent back for round 6:

- **Maintenance:** both views, the drawing and a list to read the plan over (print-like, not only
  for printing). Plan, Do and Record are still hard to tell apart; some colour is needed, not the
  warning amber.
- **Step 7 on a rack:** what the edge squares look like on a racked device.

## Round 7, answered 2026-10-02 (after a product review)

Reverses parts of round 5:

- **One look switch replaces cable and diagram styles** (and ADR-0060 step 9's three styles). Each
  person picks Rack (faceplates, dressed cables) or Diagram (boxes, square-cornered lines); the
  design sets the starting choice. A cable whose far end is off screen or far away ends in a stub
  with a far-end tag, automatically. Hanging, Stub as a style, and rack and cable overrides are
  dropped. Zoom never switches style: closer in, the same faceplate draws cleaner and fuller.
- **Handles** are small ink circles, never the free-port square. They belong to free boxes
  (equipment with no model); modelled devices draw cables from their ports. Adding into a rack is
  right-click Add here or a drag from the side panel's list. Shelf grips stay squares.
- **Maintenance:** viewing a plan draws it in one colour (indigo, dashed). Starting it switches
  to the Do colour (teal) and a checklist that runs in order: the next step opens when the
  current one is marked done or went differently. Record returns to ink. Both the drawing and the
  list view; the list works on a phone. Only people who open the plan see its marks.
- **Docs** replace the third place (§8): docs attach to a thing, a model (every unit of it), the
  design, or a maintenance plan (a method of procedure), and design-wide docs are a Docs kind in
  Inventory. A trouble issue kind may follow. Uploaded files wait for the security decision.
- **Beta keeps the full order** (§1); nothing moves after it.

- **Troubleshooting** (owner's idea): right-click a device, "It's down". Fathom lights what it
  depends on (power, cable, port, VLAN, address, gateway) and asks about each in order, nearest
  first, with OK / Not OK / Can't tell and a Why? card per step. Answers narrow it; Fathom says
  where they point, never the cause (ADR-0020). Plan a fix opens a maintenance plan; the issue is
  saved to each device's history. Drawn in ink, sheath colours dropped while it runs; colour only
  where it means something. Comes right after maintenance plans; path trace extends it later.

## Round 9, answered 2026-10-03 (the all-in-one review)

- **IP and VLAN tables:** Prefixes and VLANs are Inventory kinds; each prefix's page lists its
  addresses (what they're on, where they came from, next free) under a grid of the range. They
  read the drawing, so nothing is keyed twice; clashes come from Checks. After troubleshooting,
  before Docs.
- **Bringing a network in:** one file importer (CSV, NetBox export, Proxmox JSON, nmap XML): match
  columns, preview new / match / differ, one Undo. Read in the browser through the redaction gate;
  no stored tokens, no live connections. Same bundle as IP and VLAN tables.
- **Read-only:** a "View" choice on the existing read grant, plus PNG and PDF export. No public link.
- **Same device, same moment:** merge field by field; on the same field the later change wins and
  the other person is told at once and can put theirs back; history keeps both. No locks. Other
  people show as a small dot with their initials, not a cursor. Live co-editing comes before beta.
- **Not cards, in scope:** paste for Junos EX and EdgeOS; Checks load only what changed; PNG
  export joins print.
- **Later, so nothing designs them out:** an API; monitoring, using checks that need no device
  credentials (ping, TCP, HTTP).

Still open: private custom fields (#93 builds shared fields only).
