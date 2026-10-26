# ADR-0074: Sites, buildings and the zoom above the closet

**Status:** accepted 2026-10-26. The owner answered sign-off card r37-estate twice on 26 October.
Version 1 asked how hubs show and when to build, and the owner answered with Needs changes: "didn't
we develop an entire room builder that could pull building layouts from PDFs?", plus racks side by
side and a 2.5D view. Version 2 reworked the card on top of what already exists, and the owner
approved it with every recommended pick. The renders behind both versions are at
https://claude.ai/artifact/6zn5NdN42KwXMAqUoFe5Yb.

**Builds on, does not replace:** UI-SPEC "Zoom is one continuous camera" (seven stops), ADR-0047
(the estate stop), ADR-0050 (rows and bays), ADR-0051 (the room stop and blueprints) and ADR-0068
points 6 to 8 (Sites with rooms, Circuits, labels). **Amends** ADR-0051's order and ADR-0068
point 6, as below.

## Context

Today the camera stops at the closet. A design holds one premises, so a many-site estate is drawn
as rows of racks on one page and can't be read zoomed out (the scale estate at 14%). Three pieces
the upper stops need already exist:

- **Folders.** Home › Organisation › Folders holds Site › Building › Closet (the server's scope tree
  organisation › network › building › rack), with Read, Draw and Steward on each folder. Only a
  Steward makes one (`FoldersPanel.tsx`).
- **The room builder** is designed in ADR-0051 and `design/places/Room`, but not built. A plan image
  or PDF page sits behind the room, scaled by two points. Walls are traced with snapping, rooms are
  suggested and then accepted or rejected, and DXF can be imported.
- **Racks side by side.** Racks that share a Row already stand side by side, bays left to right
  (ADR-0050 §2).

## Decided

1. **Where buildings and sites live: the folders already there, drawn.** The building, site and
   estate stops draw the Site › Building › Closet folders. A design sits in a closet folder, and
   zooming out of it shows its building, then its site, then every site the person may see. A
   folder gains a kind (central office, datacenter, hut, cabinet, headend, customer premises,
   other) and a role (Hub, Branch, Customer, Other) set by hand. There is no second store of
   places. Who may add, draw or read follows the folder, and so does what an AI connection sees.
2. **Hubs are set by hand.** A hub is drawn with a double border. Fathom never works the role out
   from links.
3. **Many small sites fold behind their hub** as a counted stack ("+22 sites") that unfolds as the
   camera nears it, the way a cable bundle (×4) does. A site with a warning or a missing link stays
   out of the stack.
4. **Rooms and floor plans: build ADR-0051's room builder as designed.** The plan image or PDF page
   comes first, then tracing with snapping and suggested rooms. DXF follows once the owner has a
   real blueprint to test against, and automatic wall finding only if a real plan shows it beats
   tracing. This replaces ADR-0068 point 6's "light floor layout" with that design.
5. **Racks: keep rows, and save a rack dragged by hand.** A rack dropped on the free-form canvas
   keeps its place, as a `LayoutPin` (the drawing heading, OPEN-QUESTIONS D5), saved as seen from
   the front and mirrored when its row shows the rear. Undo returns it to its bay slot. A
   read-only viewer's drag lasts only the session. **Built with this record.**
6. **No 2.5D view now.** A tilted view hides labels behind racks and makes it hard to tell what is
   being clicked. The flat room plan plus the row elevation already show what's next to what.
7. **When:** with Sites and rooms, which is already next in the mapping order (ADR-0068 round 26
   point 5). Carrier names and circuit IDs on links between buildings and sites arrive with
   Circuits (ADR-0068 point 7), and those links are circuit records drawn, not a new kind.
8. **Ships with it:**
   - Docs: STATE.md, UI-SPEC "The building" and the estate section, a worked task in EXAMPLES.md
     ("add a building and its closets"), and a Learn explainer on how sites, buildings and closets
     set who can see what.
   - AI connector (ADR-0072), with no new powers: `read_design` says where the design sits (site ›
     building › room) and the hub role, `list_designs` filters by folder, and `recommend` can
     suggest rooms, racks and links as ideas a Draw person accepts.
   - The importer fills sites, locations and racks from NetBox's `site` and `location` columns,
     which it recognises today and drops, as one plan to accept.
   - Room-door labels (ADR-0068 point 8) open the room.

## Who, why, how

- **Who.** A Steward on a site adds its buildings, closets and rooms, sets the hub role and drops in
  the plan. Draw on a building draws rooms, racks and cables. Read zooms, looks, prints and sends
  corrections. An AI connection sees only the folders its grant names.
- **Why.** To find where a thing is and which door to go through. To see which hub feeds a building
  that is down, and what else hangs off that hub. To find free racks and power for a new closet.
  To teach a new hire how the network fits together.
- **How.** Home › Organisation › Folders › New site (as today, plus kind and role), then New building,
  then open the building and drop a floor plan or draw a room. A closet, datacenter or UPS room
  becomes a closet folder, and existing designs are dragged into it on Home. Or import from NetBox.
  A link between buildings is dragged from a portal tray and makes a circuit.

## Consequences

Decision 5 is on main with this record (`document/view.ts` `RackView.pin`, `Drawing.tsx`,
`scripts/drive-rack-place.mjs`). Everything else waits its turn in the mapping order. No schema
change is needed for decision 5. Rooms, floors and the folder kind and role need one when they are
built.
