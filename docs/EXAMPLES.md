# Worked examples

Short walkthroughs of tasks main supports today (brought up to main 2026-10-23). Wording on screen may
differ slightly; `docs/STATE.md` is the page of record.

## 1. Paste a device config

Browser paste understands **Junos SRX**, **Junos EX**, **EdgeOS**, **OPNsense** (rules-migration CSV),
**MikroTik RouterOS** (`/export`), **pfSense** (`config.xml` backup), a **TP-Link** JetStream or Omada
switch's config, and a **Linux host's** `ip addr` / `ip link` output. It tells them apart from the text; when it can't, the card asks "Which device is this
from?" (that picker offers the first four).

1. On the canvas, press **Ctrl+V** with the config text on the clipboard, or right-click and choose
   **Paste config**.
2. The text goes through the redaction gate in your browser. A card appears with the hostname, platform,
   interfaces and addresses it read, and a line such as "The gate destroyed 2 values before anything was
   stored", counted by kind. The values themselves are never shown or kept.
3. Choose **Attach to `<hostname>`** if a device with that name exists, or **Add as a new device**, then
   confirm. Nothing is stored before this step; **Cancel** drops it.
4. Open the device (right-click, **Open**) and press **Config** to read the capture in the drawer.

A password typed into a free-text field is not a paste, so the gate never sees it. Fathom marks it and
stores it as typed (ADR-0041).

## 2. Open a device and cable it

On a design with no devices yet, the **Equipment** list opens by itself (until you close it once on that
design), and the empty canvas has an **Add equipment** button.

1. Right-click a device and choose **Open**, or double-click it. It draws large with its ports
   (jot mode).
2. Drag equipment from the list beside it onto the canvas, or click an item to add it.
3. Drag from one port to another to draw a cable. Click a cable to see its colour and ends; a port offers
   **Select cable** and **Go to far end**.
4. **Esc**, or **← Canvas** at the top left, takes you back out. On the canvas, the **Back** button
   names where it goes, and its **▾** opens a tree of where you are inside the design.

At the canvas, hover a cable bundle to fan it open; a selected cable lights its whole path through
panels. The **Rack | Diagram** switch in the bar changes the look: faceplates, or plain boxes and lines.

## 3. Checks that say why

Checks run in your browser as you edit. The **Checks** chip in the bar counts findings and opens a
panel.

1. Connect a second cable to a port that already has one. The drop is refused with a card naming the
   rule ("A port has more than one cable on it"). A breakout port is the exception: give each cable its
   lane.
2. Cable two access ports that sit in different VLANs. The panel lists a warning for the link.
3. Click **Why?** on a finding. The card gives the plain reason, the fix, when it is acceptable, and a
   source note. Severity is a word and a glyph, never a colour.

Thirteen rules ship (`corpus/rules/`), each with fixtures that must pass and fail. Every rule's reviewer is
still "pending", and Why? says so ("Source not yet checked by a person").

## 4. Add a doc to a device

1. Select a device and use the **Docs** line in its panel (the bar's **Docs** button opens the design's).
2. Write a title and Markdown text, and add links if you like. Markdown is a safe subset: no HTML,
   images shown as words.
3. Attach a PDF, image or text file (up to 25 MB). Text is gated in your browser and only the redacted
   copy is uploaded. Images and PDFs are stored as "can't be read", because there is no PDF text check yet.

A doc on a catalogue model shows on every unit of it ("on the model").

## 5. Share a design read-only

You need steward standing at the design's scope.

1. Click **Share** in the bar (under **More ▾** on a narrow window).
2. The panel lists people in your organisation, each with a **Can** choice: **View** (see everything,
   change nothing) or **Draw** (edit).
3. Pick **View** for a colleague. Your browser signs the grant; the server checks every field of it.

Only people already in the organisation can be added. A share does not expire and covers everything
inside the scope; set the person back to no access here to end it. A reader sees a view-only chip and cannot save.

## 6. Print a rack sheet

Press **Ctrl+P** or the **Print** button. Pick this rack, every rack in the closet, or the cut sheet; A4
or Letter; cables none or all. A rack sheet draws front and rear to scale with a device table. The cut
sheet is a row per port, as .csv or .xlsx.

## 7. Plan a firmware upgrade

Set `FATHOM_FIRMWARE_FETCH_BASE_URL` first (`docs/RUNNING-IT.md`); firmware is off without it.

1. **Inventory › Firmware**: upload the image. Fathom records its SHA-256, version and models.
2. **Inventory › Models**: choose the model's version. A device behind it gets the check
   `fw.device.behind-chosen-version`; hold one back with a reason if it must stay.
3. Right-click the device, **Plan a firmware upgrade**. The plan carries the vendor's steps (Junos,
   IOS XE, NX-OS, EOS) and a one-time link the device fetches its image from.

For a box Fathom has no image for (an OPNsense router, a NAS), open the device: under **Firmware**,
type what it runs, pick its **Numbering**, and type the version chosen for it. **Plan a firmware
upgrade** (or **Add to an existing plan…** to put it in the same window as the switch) writes the
vendor's steps, chosen by **Steps for**: OPNsense, Debian, Ubuntu, TrueNAS or Synology DSM. Afterwards,
type the new running version and "behind" clears.

## 8. Look back and restore

1. Click **History** in the bar. It says first whether every save is intact.
2. Pick a save to see the design as it was, its changes outlined. **Back to now** returns.
3. **Restore this version** (Draw) makes a new save; both stay listed.

## 9. Connect Claude or another AI app

An AI app reads designs you can read, in one organisation, and sends ideas a person accepts. It never
sees passwords or the vault, and it changes a design only where both your organisation and you said it
may (ADR-0072, ADR-0077).

First, once per organisation: a Steward opens **Steward › AI rules**, ticks **AI access allowed**, adds
the people who may connect under **Who may connect AI apps**, and presses **Save**.

Then, under **Connect an AI app**, pick how your app connects:

- **It signs in (Claude, Claude Code).** Copy the address shown (it ends in `/mcp`). In Claude
  (claude.ai, desktop, phone, and Claude Code on the web): Customize › Connectors › Add custom
  connector, paste it; a Claude Code web session started after that has Fathom's tools. In Claude Code:
  `claude mcp add --transport http fathom <address>`, then `/mcp`. The app sends you to Fathom; choose
  the organisation, what it may see and for how long, and press **Allow**. This needs the server's
  `FATHOM_AI_PUBLIC_URL` (docs/OPERATING.md, "AI connections"); without it the page says so.
- **It uses a key (any app on your computer).** For an app that only starts a local MCP server, or a
  Fathom no AI company can reach. Download the helper from the link (Node 20 or later), run the
  `node fathom-ai.mjs pair <address>` line shown, paste the line it prints, choose what the key may
  read and press **Make key**. Fathom shows the key id the helper printed, and the settings to paste
  into Claude Code or an app's `mcpServers` list. `node fathom-ai.mjs check` shows what the key may do.
  The private half of the key never leaves your computer; Fathom keeps only the public half.

Either way the connection is listed under **Steward › AI**, where you or a Steward can narrow it or
turn it off; it also ends on its own after 30, 90 or 365 days. Connect the AI account your organisation
gave you, not a personal one: Fathom cannot see which account it is, so it asks you to type it, and
your Stewards and admins see what you typed beside the connection.

The AI can read the design's maintenance plans and "It's down" issues too, so you can ask it to look
over a plan or an issue. To have it draft a change, ask it to recommend one: the idea shows under
**AI ideas**, and **Make it a plan** turns its steps into a draft plan you change, schedule and work
through like any other.

An AI never changes a design itself. To let it send the change as well as the steps, a Steward sets
**What an AI may do** under **Steward › AI rules**: for editing the design, drafting maintenance plans,
troubleshooting and working through a plan, each **Off**, **Ideas** or **Proposes** (no higher than
the server's admin allows). You tick **May propose changes** when you press **Allow** or **Make key**,
and can set less for your connection later, on its page, where the server's and the organisation's
settings sit beside yours and **In effect** names whichever is holding a row back. The word beside the
connection's name (Safe, Medium, Critical or Full) says at a glance how much it can reach. The same rules page marks folders where an AI
sends ideas only or sees nothing, lists the only kinds and fields it may touch, and lowers its limits. The AI then gets a `propose_change`
tool: Fathom checks the change against the version it read and keeps it as an AI idea. Open **AI
ideas** and press **Show on canvas**: what it would change is outlined in the plan colour, tagged AI
CHANGES, and anything it would remove is greyed. **Accept and apply** makes it as your own edit, in
your name; **Dismiss** throws it away. It sets fields, adds devices, racks, ports, cables and notes,
connects them, and removes up to 20 things at a time, only of the kinds the reading shows it; it never
removes a place that still holds things. It is refused past 10 proposals a minute and if the design
moved since it read it. To undo an accepted one, use Undo or History's **Restore this version**.

## 10. Fit a card and an optic

You need Draw. A card is a module in a slot (a line card, NIM or FPC); an optic is the SFP in a port.

1. Right-click a device, **Fit a card** (or type "fit a card" in the palette). The Ports tab opens at
   the first empty slot; the catalogue's slot names are offered when the model lists them.
2. Give the slot, model and serial, and its ports as a name or a pattern, as adding a port takes it:
   `1/{1-4}`, SFP+. The ports appear on the device and say which card they are on.
3. Click a port and set its optic (type, part, serial). Drag it onto another cage to move it.
4. Or paste the device's `show inventory` (Cisco) or `show chassis hardware` (Junos): the facts card
   offers each card, optic and supply it read.
5. **Inventory › Parts** lists every card, supply and optic with its serial; edit model and serial in place.
6. To replace one, add a **Swap a part** step to a maintenance. It says which ports go down while the
   part is out, and Back out puts the old serial back.

The Cards and optics lesson walks the same steps on a sample network. An AI assistant sees each card's
slot and model and which ports are on it, never a serial.

## 11. Add a building and its closets

You need to be an admin of the organisation, or a steward of the site you add under.

1. **Home › Steward › Folders**, **New site**. Name it and, if you like, say what kind of place it
   is (central office, datacenter, hut…) and its role (Hub, Branch, Customer). A hub has a double border.
2. On the site's row, **New building**; on the building's row, **New closet**, with a kind of room
   (closet, data hall, UPS room…). **Kind and role** on a row changes them later.
3. Or **Import from NetBox**: drop a rack or device export. After the redaction gate it shows the sites,
   locations and racks as a plan, matched by name to folders you already have. Accept it to make the
   missing folders and one rack design per location; importing again makes nothing twice.
4. **Designs**, **Move** on a design's row puts it in another folder. You need steward on both; the
   move is filed in the organisation's history.
5. Open a design and zoom out past the closet: Building, then Site, then Every site. A box opens one
   level in; **Back to the closet** returns.
6. At the Building stop, under the closets: **Add a plan picture** (a scan, photo or a PDF page saved
   as an image). Click two points on it a known distance apart and type the distance. **Draw a room**:
   click each corner (walls snap square), click the first corner to close it, and name it. Name it as
   the closet folder (IDF-2) and the room opens that closet. You need Draw on the building.

**Who sees what.** A folder is also a permission. Access given at a site covers every building, closet
and design inside it; access given at a closet covers only that closet. Zoomed out, you see only the
folders you may read, so a person with one closet sees that closet and the path to it. An AI app sees
the same folders, and no more than its key allows.

## 12. Label cables and check one from a phone

1. **Inventory › Cables**, tick the cables, **Print labels**. Cables open on **Cable wrap, 24 mm tape**:
   pick the cable's thickness, and the size to set in the print dialog (margins none) is shown above the
   labels. A wrap carries the name only; pick **Cable flag** or a flat tape size for a code to scan.
   Each cable gets two labels, one for each end.
2. On a phone, point the Camera app at a flag or flat label and open the link, or open Fathom and press **Scan**.
   After sign-in the cable's page opens: its two ends, and **Label wrong** / **Not here** for a reader.
3. **Add to Home Screen** from the phone browser's share menu keeps Fathom one tap away.

## 13. Swap a dead optic from stock

1. **Inventory › Parts**, switch to **On hand**. **+ Add to stock** if the cupboard is not listed yet:
   type the spare's model and serial, or paste the list from its box.
2. **Keep at least** one or two of the model, so Checks says when the shelf runs short.
3. On the canvas, right-click the device, **It's down**: the link step says whether a spare optic is on
   hand and in which bin.
4. Plan it: a **Swap a part** step, the port, then **From stock**. The spare is kept for the step.
5. **Done** fits it. The dead optic goes into stock as retired, with where it came from; open it on
   On hand and **Send for repair** with the vendor's RMA number and the issue it was for.
