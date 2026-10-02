# ADR-0062: Inventory as a table with pages; custom fields

**Status:** accepted 2026-10-02 (owner approved round-5 card r5-inventory, option B).

## Decision

- Inventory is a rail of kinds (Devices, Racks, Cables, Interfaces, Networks, Addresses), a
  virtualised table, and the selected thing's page beside it. The page is the canvas details
  panel's editor (ADR-0046) plus tabs: Overview, Interfaces, Cables, Docs (empty), Notes, History.
- Table: columns chosen per kind and kept per viewer (localStorage), in-place edit with Tab,
  multi-select with bulk set/tag, paste from a spreadsheet (TSV/CSV, matched by Name, every cell
  through the redaction gate), filters and tag chips. Adding needs only a name.
- Custom fields (schema 0.13): `FieldDef` (name, applies_to, value_type) and `FieldValue`, on
  Device, port, Cable, Rack, VLAN and container network. Notes widen to the same kinds.
- Fields live in the design payload, so values are encrypted under the organisation content key
  with everything else.

## Not done, on purpose

- **Private fields.** A private layer cannot live in the shared payload (ADR-0053 §7), so the
  server would have to enforce it from a separate store. That needs its own design and a security
  review; only shared fields ship. The UI does not offer "private to you".
- **Organisation-wide definitions.** Definitions are per design for now.
- Config paste (step 8) and Docs tab content.
