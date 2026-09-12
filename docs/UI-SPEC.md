# The interface — approved 2026-09-11

**Pictures:** https://claude.ai/code/artifact/e4306f02-80bb-447b-99e9-7b2dede0a541
Sources in `design/rebuild/*.dc.html`. Tokens in `design/tokens.css`.

**Read this page by default. Open the pictures only when you are actually building one of these
surfaces** — they are large, and re-reading them every turn is the cost this project has already
paid once.

---

## The shape

Rack-first. The rack, its faceplates, its ports and the cables between them **are** the product.
Everything else hangs off that. No tab bar.

| | |
|---|---|
| **Left rail** | Racks in this closet · other closets · equipment palette to drag from |
| **Centre** | The racks, at whatever zoom |
| **Right** | Inspector for whatever is selected |
| **Masthead** | Scope breadcrumb · cable-kind toggles · port-colour mode · who else is here · zoom |

**Zoom is one continuous camera**: closet → rack → faceplate → port. Ports fade in as they become
big enough to hit. Never a page change.

## Ports

Four glyphs, never confusable: **RJ45** (latch notch), **SFP+** (cage with a bail), **LC** (two
ferrules), **C14** (hex inlet, three pins). Same size on every plate.

Count, position and numbering come from the **engine's equipment catalogue**, never typed. Numbered
as the label on the box reads — odd over even, 12-port groups, uplinks right.

Filled = cabled, hollow = free. Patch-facing gear (switches, panels) shows ports always; everything
else reveals on hover or selection.

## Cables

**Sag.** Every cable bows right and down, more on longer vertical runs, capped. While dragging it
droops live between the fixed port and the pointer — you see the slack before you commit.

**Colour is the real sheath.** The hue is the lead you actually used, so a cable in your hand can be
found on screen and back. Per-cable, from stock lead colours.

**Type is the line, not the hue.** Copper one stroke · fibre a pair (white core) · power heavy.

**One cable per port.** Type decided by the port you start from. Only compatible ports stay live
during a drag; the rest dim.

### Keeping it readable at forty cables

1. **Bundles** — cables sharing both ends draw as one band, width and a `×n` badge carrying the count.
2. **Fan on hover** — the band opens into its members with their port pairs, then folds back.
3. **Light the whole path** — hover any segment and the entire physical run lights in order, through
   panels and risers to the portal. A cable is a path, not a line.
4. **Lanes** — power runs one side, data the other. They never share.

Everything off the lit path sits at **28%**; the path itself carries a pale halo. This is the
"phantom" effect and it is load-bearing.

## Portals

A cable that leaves the view ends in a dashed tray above or below the rack, naming where it goes and
how many. Not an unknown — elsewhere. Click to follow.

## Power

PDU with C13 outlets in the rack. Each device's PSU inlets notated on the left rail beside it — two
hexagons for dual, filled when fed. Power leads run their own rail lane. A device with one PSU fed
is marked **single-fed**.

**Rear view**: stacked under the front when zoomed, a flip at rack scale.

## Inside a box

Same gesture as going inside a rack. **The jacks on the panel at the edge are the same ports you
cabled**, seen from inside — the cable continues through the wall.

- **Server**: bond as a box with jacks; a VLAN-aware bridge drawn as a small switch faceplate,
  because that is what it is; guests as cards with a vNIC jack on the edge. One lit path out.
  A bond member is **a choice, not a fact** — name both, guess neither.
- **Firewall**: zones are regions inside the box, interfaces sit in them. A policy set is a stack
  with an ordinal rail — a rack of rules — and rows that can never be reached are **hatched like
  free U**. Trace order: in → zone → policy → route → out.

**Fathom never says permitted or denied.** It names the zones, the set, and the policies in the order
the device reads them.

**Absent is drawn as absent**, never as "none configured".

## Config

A **drawer under the faceplate**, not a separate page. Plate stays above, dimmed; click a line and
the port it built lights, tagged with which line built it.

Gutter: ● built graph · ○ kept as text · — destroyed at the gate. A destroyed credential is a black
block that says so — gone, not hidden.

**The assistant's six rules, printed on the screen and not in a help page:** reads this config and
this graph only · cites a line for every claim · cannot see a credential ever · never says permitted
or denied · says "could not establish" over a guess · never changes the estate.

## Presence

No cursors. A dashed ring on the device someone is editing, a name chip on the rack rail, a dashed
ring on a port someone is holding mid-drag. Scoped to the view.

## Motion

Five, each tied to a real event. Nothing moves to look alive.

1. Cable droops as you pull it — slack you would really have.
2. Wrong drop: target shakes once sideways, lead springs back to your hand.
3. Path lights hop by hop, 60 ms apart, far end panned into view.
4. State change pulses **once** and settles. Never blinks, never loops.
5. Zoom is one camera.

**Excluded on purpose:** particles flowing along links. UniFi's own users complain the animation
outruns the data. If it moves, it must be true now.

## Look

`design/tokens.css` unchanged. Zero radius, no shadows, 1px hairlines, small type ramp, tabular
numerals. The three risk colours stay reserved.

---

## Open

- **Palette collision.** Red, green and orange are stock lead colours *and* the reserved risk hues.
  Separated today by location — sheath only on the canvas, risk only in panels. Alternative: a lead
  palette avoiding those three.
- **Portals** — dashed trays, or a cable that visibly runs off the edge?
- **Presence** — is no-cursors enough?
- Unfinished on the boards: SFP/LC glyphs not yet pulled into the server view; the firewall's other
  zone pairs are still a plain list.

## Parked

The building / floor-plan view. Owner: *"can be kinda cool, but not necessary."* Board is on page 3
of the canvas if it ever comes back.
