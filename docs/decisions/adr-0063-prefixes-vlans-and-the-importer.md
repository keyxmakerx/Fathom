# ADR-0063: Prefixes and VLANs in Inventory; one file importer

**Status:** accepted 2026-10-03 (round 9, owner-approved: r9-ipam A, r9-import A).

## Decision

- **Prefixes and VLANs are Inventory kinds, read from the drawing.** A prefix is the live `Address`
  nodes in one IPv4 network; VLAN, site, gateway and "where it came from" are derived (ipam.ts,
  `deriveNetworks`, provenance). No second store and no schema change. Typing an address or VLAN
  writes it to a device interface (`addSubnet`, `addVlan`); with no device it is refused.
- **Importer.** Drop CSV/TSV, NetBox (CSV/JSON), Proxmox `pvesh` JSON or nmap XML. Read in the
  browser; no network. Steps: detect, map, preview (New / Match / Differ / No model). Unknown
  columns become shared fields (ADR-0062). The whole import is one undo step (`collapseBatches`).
- **Safety.** Every string passes the wasm redaction gate before the plan is made; plan and apply
  accept only a gated table. Caps: 5 MB, 2000 rows, 100 columns, 4000 chars per cell, JSON depth 64.
  Formula-leading cells are kept as text. XML with an entity or non-bare DOCTYPE is refused; the
  bare `<!DOCTYPE nmaprun>` that nmap writes is allowed (from memory, not looked up).
- **Match never overwrites.** Same name: fill blanks only. A differing value is a Differ row;
  the default keeps yours.

## Known limits

- The gate is statement-driven: a bare secret in a cell with no statement around it is not caught.
- Apply is quadratic in rows (document commands copy sorted arrays), hence the 2000-row cap.
- "Imported" as an address origin is not produced yet. The #97 Why? card hook is left unwired.
