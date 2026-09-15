# Withdrawn — 2026-09-15

The boards in this folder proposed that inventory was not a place of its own but the far end of the
drawing's zoom, switched by a *Drawn | Listed* control in the masthead. The owner rejected that the
same day: people used the old inventory screen, and inventory has to stand as an equal to the drawing,
NetBox-style, with both editing the same graph.

ADR-0046 records the decision that replaced this: two places, Racks and Inventory; one editor shared
by the inspector and the inventory page; undo that records.

Two ideas from these boards survived into that record and are the reason the folder is kept rather
than deleted: the inspector reached two ways being one component (`InspectorTwoWays.dc.html`), and
free space as rows rather than gaps (`FreeSpace.dc.html`). Everything about *Listed* as a mode, and
the estate as a zoom level, is withdrawn.

`InventoryFirstPass.dc.html` is a byte-for-byte copy of `design/rebuild/Inventory.dc.html` and was
never a proposal; it was the original shown beside the replacement.
