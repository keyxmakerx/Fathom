# Places — approved 2026-09-18

The brief the boards in this directory were drawn from. ADR-0051 is the decision; `docs/UI-SPEC.md`
carries the rules, including the colour rule added the same day under "Look". Renders in `renders/`.
Approved by the owner on 2026-09-18 ("that all looks fantastic") with two notes: motion for the new
interactions, and a visible *reject* beside *accept* on a suggested room.

**Five boards, no animation; motion is described in a caption where it matters.** Shelf, Surfaces,
Room, Tracer, Designer. Same format and vocabulary as `design/shell/` (read `Main.dc.html` there for
the bar, the strip, the editor surface, the type ramp). Do not redraw what the shell set shows.

1. **Shelf** — the rack stop, rack A-01. A 2U shelf at U20–21 (a passive, "Shelf 2U") holding three
   boxes left to right: a mini PC with no catalogue entry (a *sketch*: 2× RJ45, 1× C14, marked as
   typed), a desktop 8-port switch, an ONT. On the plate they are named boxes; the mini PC is
   opened at the faceplate stop beside it showing its ports. The editor surface on the right shows
   the sketch's typed ports and a *placed on* control with three choices: rack, shelf, surface.
2. **Surfaces** — the closet stop. Row A's racks as today; beside them the **west wall** as a flat
   panel the height of a rack: a plywood **board** carrying an ONT, a NID and a 12-port outlet
   block at their positions; and the **floor** with a UPS standing on it, its power lead into the
   PDU in A-02. A surface has no rear and no flip; racks keep theirs.
3. **Room** — the room stop, below the building. A floor-plan image beneath at the phantom opacity,
   never full black. Three suggested rooms as dashed outlines; the one under the pointer carries
   the lit path's pale halo and a hairline ring in the recommendation colour on its accept
   affordance. One room already accepted: solid, named "214". The right-click pop-over open on
   another: reject · split · merge · name. Desks and cubicles as labelled boxes; two wall outlets
   as small marks on a wall. A view control *plan* to hide the image. Top right of the canvas, a
   confirmation notice, subtle: "Room 214 accepted", pulsed once and settled (caption).
4. **Tracer** — the room stop. A four-port wall outlet clicked: the pop-over lists its ports with
   label and run type; port 2 selected. The editor surface slid out on the right: label (editable),
   run type (cat6a), length, and a **preview**: the far switch's faceplate strip with the port lit
   and a plug drawn entering it (caption: the plug slides in, pulses once, settles; the plug is in
   the "look here" colour, the only colour on the surface), the path in words: outlet 214-A port 2
   → run 214-A-2 → patch-a01 port 14 → patch cord → core-01 ge-0/0/14, and a **Go to** button.
5. **Designer** — a surface that draws a model. Left, the form: vendor, model, height in U, faces
   front and rear, port groups (kind, role, layout, count or names), slots (name, hot-swap, face,
   position), the citation with its date. Right, the live faceplate preview drawn exactly as the
   rack would draw it. Two buttons: *save to my engine* (shown as unvouched, ADR-0044) and *export
   for a pull request*. A bordered warning wash with words where the citation is empty.

**Rules.** Black and white; colour only as "look here" (error, warning, recommendation,
confirmation) and subtle; the sheath colours only on cables. Zero radius, no shadows, 1px hairlines,
tabular numerals, the tokens in `design/tokens.css` and nothing invented. Sample names as in the
shell set. Each board renders to `renders/<Board>.png` at the same size as the shell renders.
