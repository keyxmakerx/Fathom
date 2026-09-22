# The interface — approved 2026-09-11

**The shell, approved 2026-09-16 (ADR-0047):** https://claude.ai/artifact/GkXzzMe3JG6SQAaXke9C4p —
sources and PNG renders in `design/shell/`. The bar, the stops, the lenses, the estate, optics,
tracked changes. This is the frame every other picture sits in.
**The drawing's details, approved 2026-09-11:** https://claude.ai/code/artifact/e4306f02-80bb-447b-99e9-7b2dede0a541 —
sources in `design/rebuild/*.dc.html`: Legend, Faceplate, Crossings, Motion, Hypervisor, Firewall,
Config, Building. Their masthead predates the shell and is superseded by it; their drawing stands.
The other boards that canvas shows were retired on 2026-09-16 (`docs/archive/design-retired-2026-09-16/`).
**The screens set, 2026-09-15:** https://claude.ai/artifact/9sCWD7oBYogejnCpk9pcxN — sources in
`design/proposals/screens/`. The surfaces stand; the bar on them is superseded by the shell's.
**The places set, approved 2026-09-18 (ADR-0051):** sources and renders in `design/places/` — Shelf,
Surfaces, Room, Tracer, Designer.
Tokens in `design/tokens.css`.
**The `Legend` board (`design/rebuild/`) is the one to open first when building any canvas surface** — the four
glyphs, the three line constructions, both palettes, the presence marks and the portal rule, on one
small board. The other boards show them in use.

**Read this page by default. Open the pictures only when you are actually building one of these
surfaces** — they are large, and re-reading them every turn is the cost this project has already
paid once.

---

## The shape

Rack-first. The rack, its faceplates, its ports and the cables between them **are** the product.
Everything else hangs off that.

**Two places, not a tab bar of views — ADR-0046, 2026-09-15.** *Racks*, the drawing below, and
*Inventory*, lists with a page per thing. Equals; the masthead names both and marks the current one.
Inside the drawing there are still no tabs: no physical-versus-logical view, layer two and three live
on the port. The retired client's six-tab strip does not come back. A basic inventory is in the first
usable version.

| | |
|---|---|
| **The bar** | One row, 44px, the 3px rule beneath, nothing else above the drawing. Fathom · Racks · Inventory (the current one marked) · the path, which opens the tree when clicked · the lens, five words with one lit · search · who else is here · Undo · Redo · zoom · you (People and permissions for stewards, Site for operators, sign out). |
| **The drawing** | The whole width beneath the bar. The rail is folded to a 28px strip of marks and opens on click. |
| **The editor** | A surface: slides in on the right when something is selected, goes when you click away. The same component as the inventory page. |
| **Pop-overs** | One kind: a flat hairline box, square, no shadow, opened by a click, closed by clicking away or Esc, never more than one level. The tree, the account menu, the pickers, and right-click on anything. Hover only shows a small label after a pause. |

**ADR-0047, 2026-09-16.** The old masthead's cable-kind toggles and port-colour buttons are gone: a
lens is both. Four kinds of thing make every screen — places, stops, lenses, surfaces — and nothing
else gets a name; the record has the list.

**Zoom is one continuous camera**, seven stops: estate → site → building → closet → rack →
faceplate → inside. Ports fade in as they become big enough to hit. Never a page change. *Building*
joined on 2026-09-15 (see "The building", below); *estate* and *site* on 2026-09-16 (see "The
estate", below); *inside* is the approved Hypervisor and Firewall boards, named as a stop.

## The estate, lenses, optics, tracked changes — ADR-0047, 2026-09-16

**The estate stop.** Sites placed by hand and never auto-laid-out; the links between them drawn as
counted bundles, never single lines, with the carrier and circuit IDs on the label; a link to another
organisation goes through a portal, the same rule as a cable between closets. The tree in the path's
pop-over is how you move and how permission is held; a saved list is a saved filter across
everything; a map image may sit behind the estate, placed by hand, never required.

**Lenses.** Cables · Links · Routing · Power · Owner, one at a time. A lens changes the marks and the
colours on the same boxes; it never moves one and never hides one. In Inventory it picks the columns.
"No physical view versus logical view" stays true: routing is a lens, not a second picture.

**Optics.** A cage takes an optic before it takes a cable. Drag cage to cage; on release say what is
between them, a DAC or two optics and a fibre pair, defaulting to the last answer. The compatibility
check follows the optic, not the cage. Schema first: `Transceiver` has no fields yet.

**Tracked changes.** A maintenance record's *Show these changes* shows its changes on the drawing the
way a document does: added solid, removed faded and struck, changed as old and new, everything else
at 0.28. A view over the trail, not a second record.

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

#**Reaching a cable on a crowded plate — the owner, 2026-09-19.** A port is a thing you can click:
its panel names the device, connector, service and face, and its cable with the far end in words
and the sheath swatch, with two actions, *Select cable* and *Go to far end*; a cable's panel has
*Go to end A* and *Go to end B*, and a selected cable's two ports carry a hairline ring. A click
selects; a drag of a few pixels connects. A **cables view control** beside the lens row, *all ·
copper · fibre · power · none*, hides cables by kind and never a box; it is a view control, not a
lens, remembered per browser and never saved to the design. A refused cable drop shakes the port
once, as Motion 2 says.

## Keeping it readable at forty cables

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

**Rear view — superseded 2026-09-16 by ADR-0050.** A rack has two elevations, front and rear,
one camera and a flip: per rack at the rack stop, per row at the closet stop. The rear elevation
draws the face that faces the back, the frame mirrored and the bay order reversed, faceplates as
the vendor draws them. Inlets are ports on the rear face at their positions; a supply is a part in a
slot, so *single-fed* and *one fitted* are different marks. Management and console ports are in
the catalogue on the face that carries them.

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
6. A row flipped to rear slides its racks to their mirrored places; nothing remounts.
7. A suggestion accepted goes from dashed to solid and pulses once; rejected, it fades out.
8. The plug in a tracer preview slides into the far port, pulses once, settles.
9. A surface slides in from the right and out again; the drawing beneath does not move.
10. A box on a shelf opens at the faceplate stop by the same camera as everything else.

**Excluded on purpose:** particles flowing along links. UniFi's own users complain the animation
outruns the data. If it moves, it must be true now.

## Look

`design/tokens.css` gained `--sheath-*` and `--cable-*` on 2026-09-12, sourced from this page.
Nothing else changed: zero radius, no shadows, 1px hairlines, small type ramp, tabular numerals. The
three risk colours stay reserved — and are now kept apart from the sheath palette by form, above.

**Colour is "look here" — the owner, 2026-09-18.** The interface is black and white. Colour
appears only where the eye should go, and subtly: a hairline ring around a button, a bordered wash
with words, a notice in the top right of the canvas. Four uses and no others: an **error**, a
**warning**, a **recommendation** (a suggested room, a suggested wall, a suggested fix) and a
**confirmation** (a thing just accepted or saved, pulsing once and settling per "Motion"). A cable's
sheath is the one exception and has its own switch: under the **Cables** lens, the default at the
rack and faceplate stops, a cable draws in its true sheath colour so the lead on the screen can be
matched to the lead in the hand; under every other lens cables draw in ink and colour comes only
from that lens's meaning. The lens row is the on and off. Nothing is coloured to look alive, and
nothing decorative is coloured at all.

**The owner's clarification, 2026-09-19.** Colour is for important things and it is wanted: a
warning or error is an icon at the canvas's corner that opens into a box with a light border of
the same colour; in the config drawer a line carrying a warning or error is highlighted the same
way; under a lens whose meaning is protocol, a traced path may colour by protocol, TCP against UDP.
All of it subtle, every colour a token of the theme, never a solid fill.

---

## Places — 2026-09-18, ADR-0051

Five boards in `design/places/`, approved with two notes: the motions above, and a visible *reject*
beside *accept* on a suggested room, right-click for the fuller box. **Shelf:** a passive that
takes U; what sits on it takes a slot; a box with no catalogue entry draws from ports typed by hand
and says so. **Surfaces:** a wall, board or floor draws like a rack's elevation, flat, no rear, no
flip; a floor UPS is a chassis fixed to the floor. **Room:** the stop below the building; the plan
faint beneath, never full black; suggested rooms dashed, accepted rooms solid; furniture, outlets on
walls; a *plan* control hides the image. **Tracer:** click an outlet, pick a port, the editor shows
where it ends, the far faceplate with the port lit and the plug entering, the path in words, *Go
to*. **Designer:** a form that writes one catalogue file into your own engine, the live plates drawn
as the rack draws them, unvouched until signed, a warning wash where the citation is empty.

## Screens — 2026-09-15

The whole set, and where each stands. ADR-0046 is the decision; this is the list.

| Screen | Who | Stands |
|---|---|---|
| Sign in and enrol | everyone | built in the client |
| **Home** — organisations, the closets and designs you may open, what changed | everyone | built in the client |
| **Racks** — the drawing on this page | everyone | approved: the shell of 2026-09-16 is the frame, the 2026-09-11 boards are the drawing's details; built in the client |
| **Inventory** — lists with filters, a page per device, rack and cable that *is* the editor, bulk edit, import and export, change history from the chain, *show on rack* | everyone | redrawn 2026-09-15 as a place, the page as the editor (screens set); built in the client (basic version: lists, page, show on rack, notes, undo) |
| Search — an overlay, never a page | everyone | the far-end picker on the patching board is the same box; the overlay itself is not drawn |
| Findings and the config checker | everyone | not drawn; the first pass carried the tab strip and was retired 2026-09-16 |
| Walkthrough — the teaching half | everyone | sketched low-fi 2026-09-15 (screens set); never built |
| Firmware — stage, hash, commands (ADR-0045) | stewards | built on the server; lives inside inventory, per model |
| Vault — share, fingerprints, consent | everyone | designed; three surfaces undrawn |
| History and verify | everyone | endpoints exist; not drawn |
| **People and permissions** — members, view-only / draw / steward, seconding, suspend, invitations, the scope tree; groups and LDAP later | stewards | server built; drawn 2026-09-15 (screens set) |
| **Operator console** — account shells, invitations, organisation shells, mail behind the two-person rule, suspend, the site trail | operators | server built; drawn 2026-09-15 (screens set) |

**One editor.** The inspector on the drawing and the page in the inventory are one component; one
fills a page, the other sits in the side panel. Same fields, same code. This is what makes *edited
from either* true, and the reason inventory must never grow a second detail pane.

## The building — un-parked 2026-09-15

One more stop on the camera, above the closet. Floors down the side, rooms as boxes you drag, the
riser, every run between rooms a counted bundle and never a single cable, a floor-plan image as an
optional background and never required. The parked board on page 3 already draws exactly this. Still
open underneath it: a scanned plan image cannot say it is current or the right building, would be
missing from every export, and needs a size cap.

## The patching surface — 2026-09-15

At the faceplate zoom, **plates pull in and push out, as many as needed**, arranged by hand, cabled
between. Pull one in by search or from the rack. The arrangement is scratch and the cables are facts:
pulling a plate in does not move the device, nothing remembers where the plates were, and every cable
is recorded exactly as one drawn on the rack. Every single-plate rule holds — compatible ports only,
one cable per port, droop on the drag, colour on release, a portal when the cable leaves the closet —
and presence rings appear on pulled-in plates.

**The far-end picker suggests; it never records.** Candidates carry a reason each — the device at the
far end of the panel port you are on, the same rack, the same closet, a config line naming a neighbour
— and a connection exists only when a person drops the cable. ADR-0038 restated.

*Suggestion, not decision:* the colour picker on release defaults to the colour used last.

## Undo, comments, maintenance, notes — 2026-09-15

**Undo never erases.** The trail is append-only and sealed, so an undo is a new change that reverses
the previous one, and both are recorded: *cabled at 14:02, uncabled at 14:03*. You undo your own
changes, never a colleague's; a colleague's change in between makes your undo a visible conflict,
never a silent overwrite. Who wins is parked with live editing.

**A comment on any change**, written by the person, sealed into the same entry as the change.
Optional; the who and the when are always there.

**A maintenance record**: what was planned, its window, which devices, the changes it covered, and an
outcome the person writes — succeeded, failed, partial — with notes. Fathom never infers success. A
firmware upgrade ends here.

**A note on a device, port or rack**: the text, when, who, pasted or typed. Pasted text goes through
the redaction gate first, as a pasted config does; typed text is marked, not redacted. Notes show in
the one editor, both places.

All four are schema additions and do not exist until the schema says so.

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

## The screens set — drawn 2026-09-15; the surfaces stand, the bar is superseded (ADR-0047)

**Pictures:** https://claude.ai/artifact/9sCWD7oBYogejnCpk9pcxN. Sources in `design/proposals/screens/*.dc.html`,
laid out by `canvas.json`. Nine boards, read across then down: Home; Inventory as a place with the
page as the editor; the crossing between them; the patching surface with the far-end picker; undo
with the trail beside it; notes and a maintenance record in the one editor; people and permissions;
the operator console; walkthrough, low-fi. The crossing, patching, undo and maintenance boards move.

The shell question this section used to carry is answered on the boards: the masthead names both
places and marks the current one, and carries the account chip; on Home and the admin surfaces
neither place is marked and the zoom cluster is absent, because none of them is the camera.

Three things drawing settled that this page had not said, as drawn and open to the owner:

- Undo and Redo are two chips in the masthead, the words only; Ctrl Z and Ctrl Shift Z are the keys.
- The account chip opens a menu: People and permissions, Site (operators only), Sign out.
- Home shows no presence, because it is not a shared document.

Two questions drawing surfaced, neither settled:

- **A plate pushed out while a lead is in hand** from one of its ports: the lead springs back, follows
  the plate off, or blocks the push-out. *Scratch arrangement, factual cables* does not answer it.
- **A maintenance record spanning scopes:** which scope's chain seals the outcome. `OPEN-QUESTIONS` D10.

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

## First run and sign-in — 2026-09-22, ADR-0056

**The server decides.** `GET /setup/state` says whether the deployment's first operator has a
password yet. While it answers *pending*, the client shows the first-run flow and nothing else: no
sign-in card, no links. When it answers *done*, the sign-in card. Ten comparable products were
surveyed (`docs/archive/2026-09-22-first-run-survey.md`); eight redirect every visitor to one
create-the-administrator page until one exists, and none shows a sign-in page with a setup link.

**First run, six screens, one card, a progress line ("Step 2 of 6").**
1. *Welcome.* One sentence: this server has just been set up; prove you are the person who installed
   it. One field, **Setup token**, and under it where the file is and the one command that copies it
   out. A wrong token gets one sentence and stays on this screen.
2. *Choose a password.* The address the server was started with is shown, not typed. Password and
   confirmation; "fifteen characters or more" inline.
3. *Set up your authenticator app.* The QR code first, large; beside it "Or enter this setup key"
   with the key in monospace and a copy button; a collapsed "Show the otpauth link"; one field,
   **Verification code**, with "Enter the six digits the app shows to confirm it is set up."
4. *Save your recovery codes.* Ten codes in a monospace grid, "Copy all", "Download as text file",
   the sentence that each works once and stands in for the phone, a checkbox "I have saved these"
   that enables **Continue**.
5. *Sign in with your new authenticator.* The address on show, one field, **Verification code**;
   the card signs in with the password it still holds. This is the session that lands on Home.
6. Home, signed in, the Site entry visible as today.

**Sign-in, two steps on the same card.** Address and password, one button. When the server answers
*second factor needed*, the card keeps the address on show and asks for one thing: **Verification
code**, "Six digits from your authenticator app, or one of your recovery codes." A wrong code shows
one sentence and stays there. Under the card, one link: "Forgot your password?". The identities
this browser holds a key for stay above the fields as they are.

**Names.** Authenticator app; verification code; setup key; recovery codes. Never "app code" or
"backup code" in anything a person reads.

**Invitations** are redeemed at their own address, `/invite#<token>`, which the console shows
beside the token it minted; the Enrol screen opens with the token filled. No link under sign-in.

## Parked

Nothing, as of 2026-09-16. The first-pass boards and the eight direction boards were retired on 2026-09-16 to
`docs/archive/design-retired-2026-09-16/`; the shell of that day replaces the 2026-09-11 shell board,
the screens set replaces the inventory first pass, and the vault's three surfaces are still to draw.
