# ADR-0091: One home for every control

**Status:** accepted 2026-11-12. The owner approved sign-off card `r116-control-homes` with every
recommended pick. The walk of main 9fbbfd5 that led to it, and the full table of where each control
sat before, is in the PR that adds this record. Where this record and `docs/UI-SPEC.md` or an
earlier round disagree, this record wins.

## Why

The same control sat in different places on different views (Undo in the bottom pill on Canvas and
in the bar on Inventory; the lens in the tool row on Canvas and in the bar on Inventory), three
controls said Back, panels closed three different ways, and the device menu had 17 rows.

## Decisions

1. **Five homes. A control's home follows from what it acts on, and is the same on every view.**
   - **The bar:** where you are, and things about the whole design or about you. Fathom, the four
     views, Work, the organisation and design name with its menu (rename, switch, print), the Sample
     chip, who else is here, Search, Undo, Redo, Doing, Share, the Admin pill, the account.
     Identical on Canvas, Diagram, Inventory and Sheet. On Home the four views show only once a
     design has been opened.
   - **The tool row, top left under the bar:** how you look at this view. Back, Select and Pan
     (drawings), the lens, Layers, Look, saved Views. In Inventory and Sheet the lens sits here
     beside Find.
   - **On the thing:** what you do to it (decision 3).
   - **The right edge:** panels. One strip of tabs: Equipment (drawings only), Details, History,
     Checks, Docs, plus a plan or It's down while one runs. One open at a time. Every panel has the
     same head: its name, "⋯" where the thing has a menu, one fold arrow. Esc and the panel's own
     tab fold it. Trail is a tab inside History.
   - **The bottom pill:** the camera only. Zoom out, the stop or percentage, zoom in, fit.
2. **One Back.** First in the tool row, the word "Back" with its tree, only when there is somewhere
   to go. The panel's foot no longer has one (this changes r65). Inside a device the tool row stays;
   the second strip goes, and Inside and Config sit in the panel's foot beside Trace.
3. **One rule for each gesture.**
   - Hover, after a pause: a peek, never clickable, on a nearly solid background.
   - Click: select, and one answer. With the Details panel folded, the quick card; with it open, the
     panel fills in and no card shows. "Details" on the card opens the panel, which stays open until
     folded. This changes r66, where a click showed both.
   - Double-click: go in. A device or shelf opens; a rack fits the view; a port or cable, having no
     inside, opens its panel.
   - Right-click, or press and hold: that thing's own menu. Ports and portal trays get their own.
   - Esc: step out one level.
4. **Shorter menus.** Still one list per kind of thing, built once and shown by right-click, the
   panel's "⋯", an Inventory row's "⋯" and Ctrl K (r58). An action that edits one fact about the
   thing lives in the panel beside that fact and leaves the menu. Ctrl K still finds every action.
   Greyed rows keep their one line saying why. No sub-menus.
   - Device (17 to 10): Open · Trace from here · Show in Inventory | It's down · Plan a change… ·
     Open in Termix (only when Termix is set up) | Duplicate · Copy link · Print label | Remove
     device.
   - Rack (10 to 7): Add a device here · Add a shelf · Add a cable run… | Close gaps · Copy rack,
     with its cables · Print label | Remove rack.
   - Empty canvas (10 to 8): Add a device here · Add a rack… · Add a wall | Add a label · Add an
     area · Add a note | Paste config · Paste a neighbour list (LLDP).
   - Port: Select its cable · Go to far end · Trace from here | Link to another site… | Disconnect.
   - Cable: Go to end A · Go to end B · Trace this path | Hide this cable · Needs finishing |
     Disconnect.
   - Portal tray: Open there · Go to far end.
5. **Layers and Look.** Layers holds the nine ticks and Mini-map. Look holds device style, cable
   style, cable colour and the colour key. No pop-over is taller than the window.
6. **Home.** Its tabs stay (ADR-0088). Admin sits at the right end, set apart, because it is the
   server's and not the organisation's.

## What this does not change

How cables are drawn. ADR-0060 decisions 4 and 10 (kept and extended). ADR-0088. r31's layout of
tools, pill and edge tabs, now applied to Inventory and Sheet too.

## As built, 2026-11-12

- Esc folds the open panel when the keyboard focus is inside it. Elsewhere Esc keeps its order: the
  card, then out of the device.
- A rack fits the view up to the faceplate stop (200%), not beyond.
- Inventory and Sheet show Checks, History and Docs on the edge (Checks added after sign-off r120). The
  checks engine and its mirror moved out of the canvas place into `design/useDesignEngine.ts`, held by
  DesignPlace, so both places share one module. On Inventory and Sheet the Checks panel stays folded until
  the person opens it (it would cover the list), has no Show (there is no canvas to show on), and a name
  in it opens that item's page. Once opened or folded, the choice is the same on every view.
- "Plan a firmware upgrade" left the device menu. It is a choice inside Plan a change (sign-off r120,
  option A): the add-step form now opens on "What kind of change?", and Firmware upgrade is one of the
  choices. It is also still in the panel's Firmware section and in Ctrl K.
- A portal tray's two rows are greyed unless the tray is a link to another site.
- The free-box menu is unchanged.
