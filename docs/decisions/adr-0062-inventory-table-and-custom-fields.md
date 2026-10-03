# ADR-0062: Inventory as a table with pages; custom fields

**Status:** accepted 2026-10-02 (owner approved round-5 card r5-inventory, option B).

## Decision

- Inventory is a rail of kinds (Devices, Racks, Cables, Interfaces, Networks, Addresses), a
  virtualised table, and the selected thing's page beside it. The page is the canvas details
  panel's editor (ADR-0046) plus four tabs: Overview, Ports, Notes, History (Docs is hidden until it exists).
- Table: columns chosen per kind and kept per viewer (localStorage), in-place edit with Tab,
  multi-select with bulk set/tag, paste from a spreadsheet (TSV/CSV, matched by Name, every cell
  through the redaction gate), filters and tag chips. Adding needs only a name.
- Custom fields: definitions are organisation-wide, held on the server (migration 0035); values
  live in the design payload. Schema 0.14 has only `FieldValue` (`value`, `definition`) on Device,
  port, Cable, Rack, VLAN and container network, owned by `HasFieldValue`; `definition` is the
  definition's id. Notes widen to the same kinds.
- A definition is `{id, kind, name, type, choices, version, createdBy, archived}`. `kind` is device,
  rack, cable, port or network; `type` is text, number, date, choice or url. Name, type and choices
  are one blob sealed under the organisation content key (tenant, id, kind and key epoch in the
  associated data); the other fields are plain columns. A member holding `draw` somewhere creates (a read-only member sees fields, changes none); only the creator (while still holding `draw`) or an
  organisation admin renames, changes choices or archives. `version` guards each change (409 on
  mismatch). Archive replaces delete, so a value never points at a missing definition.
- API (canonical JSON bodies): `GET|POST /organisations/{o}/field-definitions`,
  `PATCH .../{id}` `{name?, choices?, ifVersion}`, `POST .../{id}/archive` `{ifVersion}`.
- Values stay in the design payload and are stored like the rest of it.

## Not done, on purpose

- **Private fields.** A private layer cannot live in the shared payload (ADR-0053 §7), so the
  server would have to enforce it from a separate store. That needs its own design and a security
  review; only shared fields ship. The UI does not offer "private to you".
- **Unique field names.** The server does not enforce unique names; the client may.
- Config paste (step 8) and Docs tab content.
