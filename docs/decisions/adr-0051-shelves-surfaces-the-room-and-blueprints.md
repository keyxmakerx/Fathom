# ADR-0051 — Shelves, surfaces, the room, your own models, and blueprints

**Status:** proposed 2026-09-18 for the owner; the order is the decision, the shapes are the
recommendation. **Amends:** `docs/NEXT.md` (the canvas sessions and the list after v0.1).

## Context

The owner asked on 2026-09-18 for five things the drawing does not hold: equipment clustered on a
shelf in a rack (mini PCs, a desktop switch); a way to draw one's own equipment, where the hookups
are, and push the layout to an engine as a contribution; devices that are not in a rack at all — a
UPS standing on the floor, an ONT screwed to a wall, gear on a backboard, free-standing boxes; a
room drawing with walls, desks, cubicles and outlets, so an ethernet run from a desk can be pathed
to its rack switch; and something for people who already have blueprints.

Three of these are half-planned. ADR-0036 anticipated a chassis on a shelf in one line: it has no
U. ADR-0044 already makes an engine a signed data pack hosted anywhere, which is exactly the
contribution model "design a layout and open a pull request" needs. The building stop, floors and
rooms and the riser, is on the interface page with a floor-plan image as an optional background.

## Decision, in the order it is built

The order rests on one fact: a schema change costs nothing before v0.1 and a migration after it.
So every shape lands in schema 0.8 before Session 7's release candidate, and the drawing of each
arrives as its own piece, the small ones before v0.1 and the large ones after.

1. **Schema 0.8, before v0.1 — the shapes.** A shelf is a passive catalogue model that occupies
   units like anything else; a device on it is placed by a new edge, *sits-on*, with a
   left-to-right slot in place of a unit. A premises gains **surfaces** — form wall, board, floor,
   desk, ceiling — and a device or passive is *fixed-to* a surface at a position on it; a
   floor-standing UPS is a chassis fixed to the floor and needs nothing else, since it already has
   outlets, an inlet and a management port. `PassiveNode.form` gains *shelf* and *outlet*. A
   panel's or outlet's pairing is written as the schema's `PassThrough` edge at placement, which
   the state page already carries. A device with no catalogue entry may carry a **sketch**: its
   ports listed by hand ("two RJ45, one C14") with the same faceplate vocabulary, marked as typed.
   The room's furniture — walls as polylines, desks and cubicles as labelled boxes, doors — is
   geometry on the premises, in the schema because rule 3 allows nothing else, and never a
   network fact.
2. **The closet, before v0.1 — the small drawings.** A shelf draws its occupants as named boxes on
   its plate, each with its ports at the faceplate stop. A surface draws as a flat panel beside the
   rows, a wall elevation, things at their positions, the same machinery as a rack's elevation. The
   editor moves a device between rack, shelf and surface.
3. **Session 6's remaining work, then Session 7** as written: inside a box, the config surface with
   the redaction gate, view-only for read, motion and look; then hardening and the v0.1 tag.
4. **After v0.1, a *places* track**, its position relative to the vault the owner's call (see
   `docs/OPEN-QUESTIONS.md` W1): (a) **the designer**, a surface that draws a model — faces, port
   groups, slots, a citation — and writes the catalogue file into your own engine, unsigned and
   shown as unvouched per ADR-0044, with "export as a pull request" once engines live in their own
   repositories; the sketch from step 1 is its simplest form and ships first; (b) **the room
   stop**, below the building: furniture, outlets as real passives on wall surfaces, the horizontal
   run as an ordinary cable from an outlet's rear to a panel's rear, a desk device cabled to the
   outlet's front, so the path walk lights desk to outlet to run to panel to patch cord to switch;
   (c) **blueprint import**, below.

## Blueprints — what is possible, what it costs

- **A picture of a plan** (a scan, a photo, a PDF page rasterised) is a background, scaled by
  marking two points a known distance apart. Already decided for the building stop; extends to the
  room stop. One builder round. The three open caveats stand: a plan image cannot say it is
  current or the right building, it is missing from every export, and it needs a size cap.
- **A vector plan as DXF** can become walls, doors and room labels. DXF is a documented plain-text
  format of tagged pairs; lines, polylines, arcs and text on named layers cover most architectural
  exports, and the units come from the header. The person picks which layers are walls, which are
  doors, which carry room names; the importer writes furniture geometry and room boxes. A
  hand-written reader keeps the dependency gate clean. About one session, after the room stop
  exists, and it wants a real blueprint from the owner to test against, since a hand-made file
  proves the parser and not the world. Blocks, nested inserts and splines are the long tail; the
  first version says what it skipped.
- **DWG** is proprietary and binary; reading it means a large foreign dependency. Not supported:
  every CAD tool exports DXF.
- **Vector PDF** keeps paths but needs a PDF content-stream reader and a decompressor, a dependency
  argued through the gate; later, if DXF proves insufficient in practice.
- **Recognising walls in a scanned image** is a research problem, not a feature; out of scope.
  The scan stays a background and a person draws over it.

## Consequences

Schema 0.8 goes ahead of the config surface in Session 6, because the config surface changes no
schema and the shapes must precede the release. The places track is added to the list after v0.1.
Nothing already decided is reopened: engines stay data packs, the building stop stays a zoom
level, a field not in the schema still does not exist.
