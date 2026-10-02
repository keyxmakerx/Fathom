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
