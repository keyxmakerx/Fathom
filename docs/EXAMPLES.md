# Worked examples

Short walkthroughs of tasks main supports today. Open pull requests (#136, #137, #138) and the ticked
ideas (#141, not on main) are not covered. Wording on screen may differ slightly; `docs/STATE.md` is the page of record.

## 1. Paste a device config

Browser paste understands **Junos SRX**, **Junos EX**, **EdgeOS** and **OPNsense** (rules-migration
CSV). It tells them apart from the text; when it can't, the card asks "Which device is this from?".

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

1. Right-click a device and choose **Open**, or double-click it. It draws large with its ports
   (jot mode).
2. Drag equipment from the list beside it onto the canvas, or click an item to add it.
3. Drag from one port to another to draw a cable. Click a cable to see its colour and ends; a port offers
   **Select cable** and **Go to far end**.
4. **Esc**, or the path in the bar, takes you back out.

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

Twelve rules ship (`corpus/rules/`), each with fixtures that must pass and fail. Every rule's reviewer is
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

## 8. Look back and restore

1. Click **History** in the bar. It says first whether every save is intact.
2. Pick a save to see the design as it was, its changes outlined. **Back to now** returns.
3. **Restore this version** (Draw) makes a new save; both stay listed.
