# The interface — approved 2026-09-11

**Partly replaced by ADR-0060 (2026-09-27).** It sets these: one canvas with detail added by
degrees, the places named Canvas and Inventory, a labelled side panel, right-click menus, and
Organisation and Admin tabs on the home screen. Where this page and ADR-0060 disagree, ADR-0060 wins.

**Sources.** Read this page by default; open a picture only when building the surface it shows.
- **Shell** (ADR-0047): https://claude.ai/artifact/GkXzzMe3JG6SQAaXke9C4p, `design/shell/`. The frame
  for every other picture.
- **Drawing details:** https://claude.ai/code/artifact/e4306f02-80bb-447b-99e9-7b2dede0a541,
  `design/rebuild/*.dc.html` (Legend, Faceplate, Crossings, Motion, Hypervisor, Firewall, Config,
  Building). Their masthead is superseded by the shell; their drawing stands. **Open `Legend` first for
  any canvas surface.**
- **Screens set:** https://claude.ai/artifact/9sCWD7oBYogejnCpk9pcxN, `design/proposals/screens/`. The
  surfaces stand; the bar on them is superseded by the shell's.
- **Places set** (ADR-0051): `design/places/` (Shelf, Surfaces, Room, Tracer, Designer).
- Tokens: `design/tokens.css`.

---

## The shape

One canvas, detail added by degrees (ADR-0060, 2026-09-27, which replaced "rack-first" here). The
canvas takes free boxes and lines as well as racks, walls and ports; the rack, its faceplates, its
ports and the cables between them are the most detailed thing on it, not the only thing. Where this
spec and ADR-0060 disagree, ADR-0060 wins.

**Two places, not a tab bar of views (ADR-0046).** *Canvas* (*Racks* in older text and pictures), the
drawing below, and *Inventory*, lists with a page per thing. Equals; the masthead names both and marks
the current one. Inside the drawing there are no tabs: no physical-versus-logical view, layer two and
three live on the port. The retired client's six-tab strip does not come back.

| | |
|---|---|
| **The bar** | One row, 44px, the 3px rule beneath, nothing else above the drawing: Fathom · Canvas · Inventory · the path (opens the tree) · the lens (five words, one lit) · search · who else is here · Undo · Redo · zoom · you. ADR-0060 decision 7 moves People and permissions and Site to the Home tabs; the menu keeps only personal things and sign out. |
| **The drawing** | The whole width beneath the bar. ADR-0060 replaces the rail folded to a 28px strip of unlabelled marks with a labelled side panel. |
| **The editor** | A surface that slides in on the right when something is selected and goes when you click away. The same component as the inventory page. |
| **Pop-overs** | One kind: a flat hairline box, square, no shadow, opened by a click, closed by clicking away or Esc, never more than one level. The tree, the account menu, the pickers, right-click on anything. ADR-0060 adds hover names on controls (this spec had hover show a label only after a pause). |

A lens is both the cable-kind toggle and the port-colour control; the old masthead's separate toggles
are gone (ADR-0047). Four kinds of thing make every screen (places, stops, lenses, surfaces); nothing
else gets a name.

**Zoom is one continuous camera**, seven stops: estate → site → building → closet → rack → faceplate →
inside. Ports fade in as they become big enough to hit. Never a page change. *Inside* is the approved
Hypervisor and Firewall boards. ADR-0060 decision 10 governs how a device is opened.

## The estate, lenses, optics, tracked changes (ADR-0047)

**The estate stop.** Sites placed by hand, never auto-laid-out. Links between them are counted bundles,
never single lines, labelled with carrier and circuit IDs; a link to another organisation goes through
a portal, as a cable between closets does. The tree in the path's pop-over is how you move and how
permission is held. A saved list is a saved filter across everything. A map image may sit behind the
estate, placed by hand, never required.

**Lenses.** Cables · Links · Routing · Power · Owner, one at a time. A lens changes marks and colours
on the same boxes; it never moves or hides one. In Inventory it picks the columns. Routing is a lens,
not a second picture.

**Optics.** A cage takes an optic before it takes a cable. Drag cage to cage; on release say what is
between them (a DAC, or two optics and a fibre pair), defaulting to the last answer. Compatibility
follows the optic, not the cage. Schema first: `Transceiver` has no fields yet.

**Tracked changes.** A maintenance record's *Show these changes* draws them as a document does: added
solid, removed faded and struck, changed as old and new, everything else at 0.28. A view over the
trail, not a second record.

## Ports

Five glyphs, never confusable: **RJ45** (latch notch), **SFP+** (cage with a bail), **QSFP+** (wide
cage, four lanes, no bail), **LC** (two ferrules), **C14** (hex inlet, three pins). Same height on
every plate; QSFP+ is 40×13 against SFP+'s 28×13. SC is drawn with the LC glyph until the Legend board
draws its own.

**QSFP+ is told from SFP+ by the direction of the rules inside the cage**, not by width: SFP+ has one
horizontal rule, QSFP+ three vertical rules (four lanes). Where ports first become hit targets there
is nothing to compare a width against, and the dividers survive longest as zoom drops (measured). No
bail on QSFP+: a real module has a pull tab, and the flat top stops the silhouette collapsing towards
SFP+. `/ports.html` in the client shows all five at four zooms, both themes, both states.

Count, position and numbering come from the **engine's equipment catalogue**, never typed, numbered as
the label on the box reads: odd over even, 12-port groups, uplinks right. The catalogue records QSFP+
as QSFP+; writing SFP+ into the data of record would send somebody to a rack with the wrong
transceiver.

Filled = cabled, hollow = free. Patch-facing gear (switches, panels) shows ports always; everything
else reveals on hover or selection.

## Cables

**Sag.** Every cable bows right and down, more on longer vertical runs, capped; while dragging it droops
live between the fixed port and the pointer.

**Colour is the real sheath:** the lead you actually used, per cable. Copper: grey, blue, red, yellow,
green, orange, purple, black, white. Fibre per TIA-598-C: orange OM1/OM2, aqua OM3/OM4, erika violet
OM4 (some makers), yellow OS2. Tokens `--sheath-*`. **Plastic has no dark-theme variant**; only ink
adapts. A sheath within a hairline of the page gets a hairline outline (white on light, black on dark).

**Type is the line, not the hue.** Copper one stroke · fibre a pair (pale core) · power heavy. Yellow
and orange exist on both copper and fibre; the pair tells them apart. Tokens `--cable-*`.

**Plastic is a line. Ink is a box.** A sheath colour is only ever a cable stroke (and the port it
fills). A risk colour is only ever a bordered wash with words in it: never bare coloured text, a cable
or a port. That lets a red lead and a *disruptive* chip share a screen.

**One cable per port.** Type is decided by the port you start from. Only compatible ports stay live
during a drag; the rest dim. A refused drop shakes the port once (Motion 2).

**Reaching a cable on a crowded plate.** A port is a thing you can click:
its panel names the device, connector, service and face, and its cable with the far end in words
and the sheath swatch, with two actions, *Select cable* and *Go to far end*; a cable's panel has
*Go to end A* and *Go to end B*, and a selected cable's two ports carry a hairline ring. A click
selects; a drag of a few pixels connects. **The Cables list** (GitHub issue #54), a popover hanging
from the lit Cables lens: any number of groups — a VLAN, a tag, a type or a device — on at once,
each with its own cable count, plus All and None shortcuts; a box is never hidden, only a cable, and
a ticked VLAN group's trunk member draws dashed. A cable can also be **hidden one cable at a time**
from its own panel ("Hide this cable"), independent of every group and offered to a read-only viewer
too; a bar chip counts however many are hidden and brings them all back. Both live per browser and
per design, never saved to the design. A refused cable drop shakes the port once, as Motion 2 says.

## Keeping it readable at forty cables

1. **Bundles:** cables sharing both ends draw as one band with a `×n` badge.
2. **Fan on hover:** the band opens into its members with their port pairs, then folds back.
3. **Light the whole path:** hover any segment and the whole physical run lights in order, through
   panels and risers to the portal. A cable is a path, not a line.
4. **Lanes:** power runs one side, data the other, never sharing.

Everything off the lit path sits at **28%**, the path carries a pale halo. This "phantom" effect is
load-bearing.

## Portals

**Both**: the cable sags to the edge of the view *and* ends in a dashed tray there naming where it goes
and how many cross. A tray with no cable reads as a disconnected box; a cable off the edge with no
tray reads as unknown. The tray sits above or below the rack, or on the left edge inside a box with
the arrow pointing out. When the lit path continues through it the tray's outline goes solid with the
continuation named above. Click to follow.

## Power

PDU with C13 outlets in the rack. Each device's PSU inlets are on the left rail beside it, two hexagons
for dual, filled when fed. Power leads run their own rail lane. One PSU fed is marked **single-fed**.

**Rear view (ADR-0050).** A rack has two elevations, front and rear: one camera and a flip, per rack at
the rack stop and per row at the closet stop. The rear draws the back face, frame mirrored and bay
order reversed, faceplates as the vendor draws them. Inlets are ports on the rear face at their
positions; a supply is a part in a slot, so *single-fed* and *one fitted* are different marks.
Management and console ports are in the catalogue on the face that carries them.

## Inside a box

Same gesture as going inside a rack. **The jacks on the panel at the edge are the same ports you
cabled**, seen from inside; the cable continues through the wall.
- **Server:** bond as a box with jacks; a VLAN-aware bridge drawn as a small switch faceplate; guests as
  cards with a vNIC jack on the edge. One lit path out. A bond member is **a choice, not a fact**: name
  both, guess neither. Its 10G jacks are SFP+ cages; the LC glyph lives on the patch panel.
- **A virtual link has no sheath.** vNIC → bridge → bond draws muted (ink when lit) and takes a colour
  only at the jack where it becomes a cable.
- **Firewall:** zones are regions inside the box with interfaces in them. A policy set is a stack with
  an ordinal rail; rows that can never be reached are **hatched like free U**. Trace order: in → zone →
  policy → route → out.

**Fathom never says permitted or denied.** It names the zones, the set, and the policies in the order
the device reads them. A zone pair with no policy set draws the absence and does not say what the
device does about it. **Absent is drawn as absent**, never as "none configured".

## Config

A **drawer under the faceplate**, not a page. The plate stays above, dimmed; click a line and the port
it built lights, tagged with the line that built it.

Gutter: ● built graph · ○ kept as text · — destroyed at the gate. A destroyed credential is a black
block that says so: gone, not hidden.

**The assistant's six rules, printed on the screen and not in a help page:** reads this config and this
graph only · cites a line for every claim · cannot see a credential ever · never says permitted or
denied · says "could not establish" over a guess · never changes the estate.

## Presence

No cursors. A dashed ring on the device someone is editing, a dashed ring on a port someone is holding
mid-drag, and a name chip on the rack rail: solid when editing, outlined when only looking. Scoped to
the view. Two people on one device get two offset rings. That shows the collision; **who wins is a plan
question** (`REBUILD-PLAN.md`, open before Phase 4), not a drawing one.

## Motion

Each tied to a real event. Nothing moves to look alive.

1. Cable droops as you pull it: slack you would really have.
2. Wrong drop: target shakes once sideways, lead springs back to your hand.
3. Path lights hop by hop, 60 ms apart, far end panned into view.
4. State change pulses **once** and settles. Never blinks, never loops.
5. Zoom is one camera.
6. A row flipped to rear slides its racks to their mirrored places; nothing remounts.
7. A suggestion accepted goes from dashed to solid and pulses once; rejected, it fades out.
8. The plug in a tracer preview slides into the far port, pulses once, settles.
9. A surface slides in from the right and out again; the drawing beneath does not move.
10. A box on a shelf opens at the faceplate stop by the same camera as everything else.

**Excluded on purpose:** particles flowing along links. If it moves, it must be true now.

## Look

`design/tokens.css`: zero radius, no shadows, 1px hairlines, small type ramp, tabular numerals,
`--sheath-*` and `--cable-*`. The three risk colours stay reserved, kept apart from the sheath palette
by form.

**Colour is "look here".** The interface is black and white. Colour appears only where the eye should
go, and subtly: a hairline ring around a button, a bordered wash with words, a notice in the top right
of the canvas. Four uses and no others: **error**, **warning**, **recommendation** (a suggested room,
wall or fix) and **confirmation** (just accepted or saved, pulsing once). Nothing decorative is
coloured. Every colour is a theme token, subtle, never a solid fill.
- The one exception is a cable's sheath. Under the **Cables** lens (the default at the rack and
  faceplate stops) a cable draws in its true sheath colour; under every other lens cables draw in ink
  and colour comes only from that lens's meaning.
- A warning or error is an icon at the canvas's corner that opens into a box with a light border of the
  same colour; in the config drawer a line carrying one is highlighted the same way. Under a lens
  whose meaning is protocol, a traced path may colour by protocol (TCP against UDP).

**Accepted residual:** on the dark theme black and white leads are the hardest pair to tell apart; the
outline rule is the mitigation.

---

## Places (ADR-0051)

Five boards in `design/places/`. A visible *reject* sits beside *accept* on a suggested room;
right-click gives the fuller box.
- **Shelf:** a passive that takes U; what sits on it takes a slot. A box with no catalogue entry draws
  from ports typed by hand and says so.
- **Surfaces:** a wall, board or floor draws like a rack's elevation, flat, no rear, no flip. A floor
  UPS is a chassis fixed to the floor. ADR-0060 renames *board* to *wall*.
- **Room:** the stop below the building. Plan faint beneath, never full black; suggested rooms dashed,
  accepted solid; furniture, outlets on walls; a *plan* control hides the image.
- **Tracer:** click an outlet, pick a port; the editor shows the far faceplate with the port lit and the
  plug entering, the path in words, *Go to*.
- **Designer:** a form that writes one catalogue file into your own engine, live plates drawn as the
  rack draws them, unvouched until signed, a warning wash where the citation is empty.

## Screens

ADR-0046 is the decision; this is the list.

| Screen | Who | Stands |
|---|---|---|
| Sign in and enrol | everyone | built |
| **Home**: organisations, the closets and designs you may open, what changed | everyone | built |
| **Canvas**: the drawing on this page | everyone | approved; built |
| **Inventory**: lists with filters, a page per device, rack and cable that *is* the editor, bulk edit, import and export, change history from the chain, *show on rack* | everyone | built (basic: lists, page, show on rack, notes, undo) |
| Search: an overlay, never a page | everyone | not drawn (the patching board's far-end picker is the same box) |
| Findings and the config checker | everyone | not drawn |
| Walkthrough: the teaching half | everyone | low-fi sketch; never built |
| Firmware: stage, hash, commands (ADR-0045) | stewards | server built; lives inside inventory, per model |
| Vault: share, fingerprints, consent | everyone | designed; three surfaces undrawn (below) |
| History and verify | everyone | endpoints exist; not drawn |
| **People and permissions**: members, view-only / draw / steward, seconding, suspend, invitations, scope tree; groups and LDAP later | stewards | server built; drawn |
| **Operator console**: account shells, invitations, organisation shells, mail behind the two-person rule, suspend, the site trail | operators | server built; drawn |

**One editor.** The inspector on the drawing and the inventory page are one component, one filling a
page and the other sitting in the side panel. That is what makes *edited from either* true; inventory
must never grow a second detail pane.

**Settled by the screens set, open to the owner:** Undo and Redo are two chips in the masthead, words
only (Ctrl Z, Ctrl Shift Z). On Home and the admin surfaces neither place is marked and the zoom
cluster is absent, because none is the camera. Home shows no presence: it is not a shared document.
(The account menu's contents changed under ADR-0060 decision 7.)

**Two questions, unsettled:**
- A plate pushed out while a lead is in hand from one of its ports: the lead springs back, follows the
  plate off, or blocks the push-out.
- A maintenance record spanning scopes: which scope's chain seals the outcome (`OPEN-QUESTIONS` D10).

## The building

One more stop above the closet: floors down the side, rooms as boxes you drag, the riser, every run
between rooms a counted bundle, a floor-plan image as an optional background. Still open: a scanned
plan cannot say it is current or the right building, would be missing from every export, and needs a
size cap.

## The patching surface

At the faceplate zoom **plates pull in and push out, as many as needed**, arranged by hand, cabled
between; pull one in by search or from the rack. The arrangement is scratch and the cables are facts:
pulling a plate in does not move the device, nothing remembers where plates were, and every cable is
recorded exactly as one drawn on the rack. Every single-plate rule holds (compatible ports only, one
cable per port, droop on the drag, colour on release, a portal when the cable leaves the closet), and
presence rings appear on pulled-in plates.

**The far-end picker suggests; it never records** (ADR-0038). Candidates carry a reason each (the
device at the far end of the panel port you are on, the same rack, the same closet, a config line
naming a neighbour); a connection exists only when a person drops the cable. *Suggestion, not
decision:* the colour picker on release defaults to the last colour used.

## Undo, comments, maintenance, notes

All four are schema additions and do not exist until the schema says so.
- **Undo never erases.** The trail is append-only and sealed, so an undo is a new change reversing the
  previous one, and both are recorded (*cabled at 14:02, uncabled at 14:03*). You undo your own
  changes, never a colleague's; a colleague's change in between makes your undo a visible conflict,
  never a silent overwrite. Who wins is parked with live editing.
- **A comment on any change,** written by the person, sealed into the same entry. Optional; who and when
  are always there.
- **A maintenance record:** what was planned, its window, the devices, the changes it covered, and an
  outcome the person writes (succeeded, failed, partial) with notes. Fathom never infers success. A
  firmware upgrade ends here.
- **A note on a device, port or rack:** text, when, who. Pasted text goes through the redaction gate
  first, as a pasted config does; typed text is marked, not redacted. Notes show in the one editor,
  both places.

## Not yet drawn: vault surfaces

Designer work from a closed brief, in this page's language, before they are built (storage §13):
- **The share dialog:** the full sorted recipient set before the authenticator touch, each with a
  nine-word fingerprint phrase and trust state; the mode marker and its sentence in the same dialog.
- **The four fingerprint states:** `unpinned` (acknowledge once), `pinned` (quiet), `rotated` (inline,
  no red, one-click accept), `unexplained` (loud; the recipient is dropped and no wrap is produced; no
  "proceed anyway"; wording names both explanations).
- **The mode-change consent screen:** the full statement before the touch, in the register of storage
  §12.6.

## Owed to the boards, and two numbers not named

- `Legend` needs a fifth column in band 1 at true size (40×13, no bail), captioned "wide cage, four
  lanes", and its masthead should say five glyphs. `Faceplate`'s rear QSFP+ placeholder is a bailed
  SFP+ at 40×16 and should be this glyph at 40×13.
- **The zoom at which ports become hit targets has no number.** Name it here, not in the code, when the
  faceplate surface is built.
- **Port-colour mode and the lane dividers are undecided:** whether QSFP+'s page-coloured dividers stay
  page-coloured over a sheath fill, or invert. Only this glyph has interior detail.

## First run and sign-in (ADR-0056)

**The server decides.** `GET /setup/state` says whether the first operator has a password yet. While
*pending*, the client shows the first-run flow and nothing else: no sign-in card, no links. When
*done*, the sign-in card.

**First run: five screens, one card, a progress line ("Step 2 of 5"); Home is not a step.** Each screen
has one heading, below the progress line, never both naming the step.
1. *Welcome.* One sentence: this server has just been set up; prove you installed it. One field,
   **Setup token**, with where the file is and the one command that copies it out. A wrong token gets
   one sentence and stays here.
2. *Choose a password.* The address the server was started with is shown, not typed. Password and
   confirmation; "fifteen characters or more" inline.
3. *Set up your authenticator app.* QR code first, large; beside it "Or enter this setup key" in
   monospace with a copy button; a collapsed "Show the otpauth link"; one field, **Verification code**
   ("Enter the six digits the app shows to confirm it is set up.").
4. *Save your recovery codes.* Ten codes in a monospace grid, "Copy all", "Download as text file", the
   sentence that each works once and stands in for the phone, and a checkbox "I have saved these" that
   enables **Continue**.
5. *Sign in with your new authenticator.* Address on show, one field, **Verification code**; the card
   signs in with the password it holds. This session lands on Home, signed in, the Site entry visible.

**Sign-in, two steps on one card.** Address and password, one button. On *second factor needed* the
card keeps the address on show and asks for one thing, **Verification code** ("Six digits from your
authenticator app, or one of your recovery codes."). A wrong code shows one sentence and stays. Under
the card, one link: "Forgot your password?". Identities this browser holds a key for stay above the
fields.

**Names.** Authenticator app; verification code; setup key; recovery codes. Never "app code" or "backup
code" in anything a person reads.

**Invitations** are redeemed at their own address, `/invite#<token>`, which the console shows beside the
token it minted; the Enrol screen opens with the token filled. No link under sign-in.
