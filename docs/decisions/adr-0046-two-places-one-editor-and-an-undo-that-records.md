# ADR-0046 — Two places, one editor, and an undo that records

**Status:** Accepted, 2026-09-15
**Owner direction, 2026-09-15**, across one conversation: *"we've seen how people need that
inventory screen"*; *"netbox style functionality, but paired equally detailed with animations and
easy to understand graphical layouts that can be edited from either"*; *"the building floor plan
would be something that the canvas layer would have"*; *"add logs to equipment, manually"*; *"small
drag faceplates, and you can drag as many in and out of the canvas as needed"*; *"full undo and redo"*;
*"auditing with comments … maintenance was gonna be a thing and you can write down successful or
not."*
**Amends:** `docs/UI-SPEC.md` "The shape" (the sentence *no tab bar*), and its "Parked" section;
`docs/REBUILD-PLAN.md`'s placement of inventory after the first usable version; `docs/NEXT.md`'s
target for the first usable version. **Withdraws** the "Listed" proposal of 2026-09-15
(`design/proposals/inventory/`), which read *no tab bar* as *no inventory screen*.

---

## 1. Two places, not one

The product has **two top-level places** and they are equals: **Racks**, the drawing approved on
2026-09-11, and **Inventory**, lists with filters and a page per thing. A person goes to one or the
other. The masthead names both; the current one is marked.

This is not the six-screen tab strip of the retired client (Diagram, Inventory, Rack, Findings,
Walkthrough, Config), which the two stray first-pass boards still carry. It is two. Findings and
walkthrough are surfaces inside those two, not places beside them.

*No tab bar* in the interface page meant, and still means, that **the drawing has no tabs**. There is
no physical view versus logical view; layer two and three live on the port, in the inspector, and you
never leave the rack to read them. That rule is untouched. It was never a rule about inventory, and
reading it as one was the mistake this record corrects.

## 2. One editor

**The inspector on the drawing and the page in the inventory are one component.** Same fields, same
code, one grows to fill a page and the other sits in the side panel. This is the whole mechanism
behind *"edited from either"*: two editors over one graph would drift, and the day they disagreed
about a switch, *estate of record* would stop being true.

Consequences that follow, and are decided with it:

- **Selection carries across.** Any inventory row has *show on rack*, which lands on the drawing with
  that thing selected. Any device on the drawing has *open in inventory*, which lands on its page.
- **Nothing in a list is typed.** Counts, models, port totals and positions come from the graph and
  the catalogue, the same rule that already says port numbering is never typed.
- **Free space is inventory.** A free run of rack units, a free port and an unfed power inlet are rows,
  because absent is drawn as absent.
- **A saved list is a saved filter.** *OPEN-QUESTIONS* asks whether named lists ("the Q3 firewall
  refresh") need a data model. Over one graph they are a stored filter and a name, which is a small
  feature and not a second dataset. Whether to build it stays open; what it is does not.

## 3. Home, and search

**Home** is what you see after sign-in and nobody had specified it: the organisations you belong to,
the closets and designs you may open, what changed recently. An account with exactly one place to go
lands there directly, with the breadcrumb saying where it is.

**Search** is an overlay, not a place. One box that jumps to anything, and the same box that picks a
far end on the patching surface (§5).

## 4. The building is a stop on the camera

The owner reopened the parked building view on 2026-09-15 and placed it where the parked board
already puts it: **one more level of the same camera, above the closet**. Floors down the side,
rooms as boxes you drag, a riser, every run between rooms a counted bundle and never a single cable,
a floor-plan image as an optional background and never required. The camera is now
building → closet → rack → faceplate → port.

The question under it stays open: a scanned plan image cannot tell you it is current or even the
right building, would be missing from every export, and needs a size cap.

## 5. The patching surface

At the faceplate zoom, **plates can be pulled in and pushed out, as many as needed**, arranged by
hand, and cabled between. Pull a plate in by search or from the rack. Three rules keep it honest:

1. **The arrangement is scratch; the cables are facts.** Pulling a plate in does not move the device.
   Nothing remembers where the plates were. Every cable drawn is recorded exactly as one drawn on
   the rack would be.
2. **Every single-plate rule still applies.** Only compatible ports stay live, one cable per port,
   the droop on the drag, the colour picked on release, and a cable between two closets still goes
   through a portal on the real map.
3. **Presence still shows.** A ring on a port someone else is holding appears on a pulled-in plate.

**Suggestions are never facts.** The far-end picker offers candidates with a reason on each — the
device at the far end of the panel port you are on, the same rack, the same closet, a config line
naming a neighbour — and Fathom records a connection only when a person drops the cable. This is
ADR-0038 restated: a cable is drawn by hand. It is also the assistant's own rule, *could not
establish* over a guess.

*Suggestion, not decision:* the colour picker on release defaults to the colour used last, because
people cable from one bag of leads at a time.

## 6. Undo that records

**Undo and redo exist everywhere a person changes the graph, and undo never erases.** The audit trail
is append-only and sealed, on purpose. So an undo is a new change that reverses the previous one, and
both are on the trail: *cabled at 14:02, uncabled at 14:03*. For the person it is ordinary undo. For
the record it is the truth.

A person undoes their own changes and never a colleague's. If a colleague changed the same thing in
between, the undo becomes a **visible conflict**, never a silent overwrite. Who wins is the question
`docs/UI-SPEC.md` parks until live editing is built, and this record does not settle it.

## 7. Comments sealed with the change, and maintenance records

**A comment on any change.** The *why*, written by the person, sealed into the same audit entry as
the change so it cannot be edited later without breaking the seal. Optional on every change; the who
and the when are always there.

**A maintenance record**, a thing of its own in the schema: what was planned, its window, which
devices, the changes it covered, and **an outcome a person writes** — succeeded, failed, or partial —
with notes. Fathom records what the person says happened and never infers success, which is the
same rule as *never says permitted or denied*. A firmware upgrade under ADR-0045 ends here: staged,
attempted, then the operator's word on how it went.

**Notes on equipment.** A note on a device, a port or a rack: the text, when it was captured, who
added it, and whether it was pasted or typed. **Pasted text goes through the redaction gate first**,
exactly as a pasted config does — `CLAUDE.md` rule 4 — so an ARP table is kept as it is and a log
with a password in it loses the password before anything is stored. Typed text is marked and not
redacted, the existing decision (ADR-0041). Notes show in the one editor, both places.

All three are schema additions. By `CLAUDE.md` rule 3 that is where they start; nothing here exists
until the schema says it does.

## 8. What this changes in the plan

- **Inventory joins the first usable version**, in a basic form: lists, the page, *show on rack*.
  The owner's evidence is that people used the old one. It does not wait for a later phase.
- **Home, people-and-permissions, and the operator console** need pictures before they are built.
  They are undrawn today. `docs/UI-SPEC.md` "Not yet drawn" carries the list.
- **The building view is no longer parked.** It is a zoom level, drawn, not yet built, and not in
  the first usable version.
- **Monitoring and live integration stay beyond alpha and beta.** ADR-0045's firmware staging is the
  one narrow exception, and it is an exception because the device does the fetching.

## 9. What is explicitly not decided here

- Who wins a live-editing conflict (§6). Parked to the phase that builds live editing.
- Whether to build named lists (§2). What they are is settled; whether is not.
- The floor-plan image (§4): currency, export, size.
- The zoom at which ports become hit targets, and port-colour mode against QSFP+'s lane dividers —
  both still owed to the interface page.
