# The interface — approved 2026-09-11

**Pictures:** https://claude.ai/code/artifact/e4306f02-80bb-447b-99e9-7b2dede0a541
Sources in `design/rebuild/*.dc.html`. Tokens in `design/tokens.css`.
**The `Legend` board on page 1 is the one to open first when building any canvas surface** — the four
glyphs, the three line constructions, both palettes, the presence marks and the portal rule, on one
small board. The other boards show them in use.

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

Five glyphs, never confusable: **RJ45** (latch notch), **SFP+** (cage with a bail), **QSFP+** (wide
cage, four lanes, no bail), **LC** (two ferrules), **C14** (hex inlet, three pins). Same height on
every plate; QSFP+ is wider because the metal is, at 40×13 against SFP+'s 28×13.

**Drawn 2026-09-14, and the reason it is not simply a wider SFP+.** The catalogue records a QSFP+
port as QSFP+, because writing SFP+ into the data of record would send somebody to a rack holding
the wrong transceiver. That left the drawing owing a glyph. **Width alone could not be the answer:**
at the zoom where ports first become hit targets there is nothing beside a port to compare a width
against, so a cage that differs only in width is a coin flip. The mark is the **direction of the
rules inside the cage** — SFP+ carries one horizontal rule, one slot; QSFP+ carries three vertical
rules, four lanes — and orientation reads alone. The dividers are the longest lines in the glyph, so
they are the last thing to survive as the zoom drops, which was measured rather than assumed.

**No bail on QSFP+.** A real module has a pull tab, not a wire latch, and the flat top is what stops
the silhouette collapsing back towards SFP+. Four alternatives were drawn and rejected; the
comparison lives at `/ports.html` in the client, which shows all five at four zooms in both themes
and both states, the way the `Legend` board shows four.

Count, position and numbering come from the **engine's equipment catalogue**, never typed. Numbered
as the label on the box reads — odd over even, 12-port groups, uplinks right.

Filled = cabled, hollow = free. Patch-facing gear (switches, panels) shows ports always; everything
else reveals on hover or selection.

## Cables

**Sag.** Every cable bows right and down, more on longer vertical runs, capped. While dragging it
droops live between the fixed port and the pointer — you see the slack before you commit.

**Colour is the real sheath.** The hue is the lead you actually used, so a cable in your hand can be
found on screen and back. Per-cable, from stock lead colours: grey, blue, red, yellow, green, orange,
purple, black, white for copper; per TIA-598-C for fibre — orange OM1/OM2, aqua OM3/OM4, erika violet
OM4 (some makers), yellow OS2. Tokens `--sheath-*`. **Plastic has no dark-theme variant** — it does
not change colour when the lights go off; only ink adapts. A sheath within a hairline of the page gets
a hairline outline (white on light, black on dark).

**Type is the line, not the hue.** Copper one stroke · fibre a pair (pale core) · power heavy. Yellow
and orange exist on both copper and fibre; the pair is what tells them apart. Tokens `--cable-*`.

**Plastic is a line. Ink is a box.** A sheath colour is only ever a cable stroke (and the port it
fills). A risk colour is only ever a bordered wash with words in it — never bare coloured text, never
a cable, never a port. That is what lets a red lead and a *disruptive* chip share a screen: one is a
line, the other is a box. Decided 2026-09-12, because the approved firewall board already puts a
caution on the canvas beside a red cable, so location alone was never going to hold.

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

Not either/or — **both**. The cable visibly sags to the edge of the view *and* ends in a dashed tray
there, naming where it goes and how many cross. A tray with no cable reaching it would read as a
disconnected box; a cable off the edge with no tray would read as unknown. Above or below the rack;
on the left edge inside a box, arrow pointing out. When the lit path continues through it the tray's
outline goes solid with the continuation named above it. Click to follow. Decided 2026-09-12.

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
  A bond member is **a choice, not a fact** — name both, guess neither. Its 10G jacks are SFP+
  cages; **the LC glyph lives on the patch panel, not the server** — a server has cages.
- **A virtual link has no sheath.** vNIC → bridge → bond draws in muted (ink when lit), and takes a
  colour only at the jack where it becomes a cable. So a black lead and a logical link never collide.
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

No cursors — **settled 2026-09-12**. A dashed ring on the device someone is editing, a dashed ring
on a port someone is holding mid-drag, and a name chip on the rack rail — solid when editing,
outlined when only looking. Scoped to the view. Two people on one device: two rings, offset. That
shows the collision; **who wins is a plan question** (`REBUILD-PLAN.md`, open before Phase 4), not a
drawing one.

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

`design/tokens.css` gained `--sheath-*` and `--cable-*` on 2026-09-12, sourced from this page.
Nothing else changed: zero radius, no shadows, 1px hairlines, small type ramp, tabular numerals. The
three risk colours stay reserved — and are now kept apart from the sheath palette by form, above.

---

## Closed 2026-09-12

All four items that were open at approval are decided above: the palette collision (plastic is a
line, ink is a box), portals (both), presence (no cursors, settled), and the two unfinished boards
(the server now has SFP+ cages with a fibre pair leaving; the firewall's other zone pairs are the
same stack object, collapsed, with their ordinals on the rail). The `Legend` board carries all of it.

**Residuals, accepted rather than open:**

- On the dark theme, black and white leads are the hardest pair to tell apart — as in a dark
  cabinet. The outline rule is the mitigation; there is no better one that keeps colour honest.
- The firewall board no longer says *implicit deny* for a zone pair with no policy set. Fathom draws
  the absence and does not say what the device does about it. That is the rule applied, not a loss.

## Not yet drawn — vault surfaces, 2026-09-12

Three surfaces the vault design (storage §13) needs and this page does not have. They are designer
work from a closed brief, in this page's language, before they are built:

- **The share dialog** — the full sorted recipient set rendered before the authenticator touch, each
  with a nine-word fingerprint phrase and its trust state; the mode marker and its sentence in the
  same dialog.
- **The four fingerprint states** — `unpinned` (acknowledge once), `pinned` (quiet), `rotated`
  (inline, no red, one-click accept), `unexplained` (loud; the recipient is dropped and the wrap is
  not produced; no "proceed anyway"; wording names both explanations).
- **The mode-change consent screen** — the full statement rendered before the touch, in the
  register §12.6 of the storage design already uses.

## Owed to the boards, and two numbers this page does not name — 2026-09-14

The glyph exists in the client; the pictures have not caught up. The `Legend` board needs a fifth
column in band 1 at true size, 40×13 and no bail, captioned "wide cage, four lanes"; its masthead
line says four and should say five; and the `Faceplate` board's rear QSFP+ placeholder is currently
a bailed SFP+ at 40×16 and should be this glyph at 40×13.

Two things this page has never specified, both found by drawing rather than by reading:

- **The zoom at which ports become hit targets has no number here.** "Ports fade in as they become
  big enough to hit" is the rule and it is the right rule, but the glyph work needed a figure to
  test against and derived one from the `Faceplate` board's port pitch. Name it when the faceplate
  surface is built, and name it here rather than in the code.
- **Port-colour mode and the lane dividers are undecided.** "Filled = cabled" plus "the port it
  fills" means a cabled port can carry the sheath colour, and QSFP+'s dividers are drawn in the
  page colour against an ink fill. Whether they stay page-coloured over a sheath fill, or invert, is
  not decided. It only arises for the glyph that has interior detail, which is this one.

## Parked

The building / floor-plan view. Owner: *"can be kinda cool, but not necessary."* Board is on page 3
of the canvas if it ever comes back.
