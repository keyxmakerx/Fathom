# ADR-0083: IP management — a plan store beside the drawing

**Status:** proposed 2026-11-02. Waiting on sign-off card `rip-ip-store` (Sign-offs page). Each
choice below is marked with the pick pre-selected on the card; a different answer on the card
changes this record before it is accepted. Nothing here is built.

**Builds on:** ADR-0067 (prefixes and VLANs read from the drawing, the file importer), ADR-0079 (the
estate index across designs, sealed with keyed search terms), ADR-0074 (sites, buildings and closets
are folders), ADR-0063 (live changes). **Starts from:** card r75-work-plan, approved 2026-11-02 with
"Where IP plans live" A: planned and reserved addresses get their own store, the drawing stays the
truth for what is configured, and differences are shown.

**Keeps:** invariant 2 (Fathom never touches a network device; nothing here reaches one), rule 3 (the
store's records are declared in `schema/` before any code uses them), rule 4 (an import still passes
the redaction gate first).

## What the owner asked for

From the r74 note, as summarised on r75: IP management *stronger than NetBox*, and orders (a DIA
circuit and the like) that carry their IP breakdown and can ask for IPs before the router exists.

## What Fathom has today

Read from main at e7a788c on 2026-11-02.

- `client/src/document/ipam.ts` derives prefixes from the `Address` nodes on drawn interfaces. It
  reads IPv4 only; an IPv6 address is listed, not read (line 5, line 29). It already has
  `nextFree` and `freeRuns` inside one derived prefix.
- The schema's `Address` kind already carries `family: inet | inet6` (schema.yaml, `kind: Address`),
  and `RoutingInstance` carries a route distinguisher and targets. So the drawing can hold IPv6 and
  VRFs; the browser's IPAM code just doesn't read them.
- Nothing can be planned or reserved without a device: `addSubnet` refuses with no device
  (ADR-0067).

## What NetBox has

Read from NetBox's own documentation on 2026-11-02. The docs site's version picker shows "Latest
(v4.7.4)"; v4.7.4 is dated 27 October 2026 in its release notes. Not from memory (CLAUDE.md rule 1).

| NetBox has | Source |
|---|---|
| Aggregates as the root of the tree, each assigned to an RIR; prefixes nest automatically ("IP objects in NetBox never need to be manually assigned to the parent objects"). | netboxlabs.com/docs/netbox/features/ipam/ |
| Prefix: IPv4 or IPv6, status (Container, Active, Reserved, Deprecated), VRF or the global table, role, scope (region, site group, site or location), VLAN, *is a pool*, *mark utilized*. Container prefixes count child prefixes for utilisation; others count addresses and ranges. | netboxlabs.com/docs/netbox/models/ipam/prefix/; statuses from netboxlabs.com/blog/netbox-ipam/ (5 July 2023) |
| IP range: start and end, VRF, role, status, *mark populated* (counts as full and blocks addresses inside), *mark utilized*; at most 2^32 − 1 addresses. | netboxlabs.com/docs/netbox/models/ipam/iprange/ |
| IP address: status, role (Loopback, Secondary, Anycast, VIP, VRRP, HSRP, GLBP, CARP), assigned to an interface or an FHRP group, VRF, DNS name, NAT inside/outside, one primary per family per device. | netboxlabs.com/docs/netbox/models/ipam/ipaddress/ |
| VRF: optional route distinguisher, import and export route targets, tenant, *enforce unique* (off by default); the global table has its own `ENFORCE_GLOBAL_UNIQUE` setting. | netboxlabs.com/docs/netbox/models/ipam/vrf/ |
| VLAN group: VID ranges (default 1–4094, no overlap), a scope, unique ID and name within the group. | netboxlabs.com/docs/netbox/models/ipam/vlangroup/ |
| Next available: `available-ips` and `available-prefixes` on a prefix, and `available-ips` on a range, list and create, several at once. | netboxlabs.com/docs/sdks/pynetbox/ipam/ |
| Allocation holds a lock: "Each holds an advisory lock while it allocates, so concurrent requests are never handed the same value." | quoted in netbox-community/netbox issue #23411 (opened 15 October 2026) |
| Asking twice is not safe. Issue #23411 (open, "under review") says a retry after a dropped connection creates a second object, allocations don't record their source pool, and a unique custom field is checked in `clean()` rather than by a database constraint. A maintainer's reply (27 October 2026) suggests claiming the address at once by setting its status to *reserved*. | github.com/netbox-community/netbox/issues/23411 |
| Comparing what is documented with what is really on the network is NetBox Assurance, which "is not available for NetBox Community Edition"; it is a NetBox Cloud add-on or a NetBox Enterprise component. | netboxlabs.com/docs/assurance/ |

What NetBox's *reserved* status does not have, by those pages: a holder, a reason tied to a piece of
work, or an end date. Nothing in them frees a reservation that was forgotten.

## Decided (pending the card)

1. **An IP plan store per organisation, beside the designs.** *(card: Where the plan lives, A)*
   Aggregates, prefixes, ranges, reservations, VRFs and VLAN groups live in one store for the
   organisation on the server, not inside a design. A design loads whole and is one site
   (ADR-0079), but address space spans sites, and an order must reserve a /29 before any design
   holds the router. Each block can be given a folder (a site, building or closet, ADR-0074); a
   block with no folder belongs to the organisation.
   - **Who may do what:** Read on a block's folder to see it; Draw on that folder to reserve inside
     it or release a reservation; Steward to make or change aggregates, VRFs and VLAN groups, and to
     release someone else's reservation. Teams (ADR-0081) join here when they land, the way they
     join folder grants.
   - **Sealed like the estate index** (ADR-0079 decision 3): each record's contents are encrypted
     under a key derived from the organisation's master key with its own HKDF label. Every change is
     a signed entry on the organisation's change chain, so who reserved what, and when, is in the
     sealed history like a grant.

2. **The drawing stays the truth for what is configured; the store holds what is intended.**
   *(card: How the plan and the drawing meet, A)* Nothing in the store writes to a design, and
   nothing in a design writes to the store on its own.
   - An `Address` drawn on an interface **matches** a plan record when the address is inside a
     planned prefix with the same length and VRF, or equals a reserved address. A reserved address
     that is now drawn shows as *In use* with a link to the device.
   - **Differences are checks**, listed on the address page and in the Checks panel:
     *configured but not planned* (with Adopt, which makes a plan record from it, and Ignore);
     *planned but not configured* (quiet while its work is open, a check once the work is done);
     *configured differently* (length or VRF differ: fix the plan, or start a plan to change the
     device); *in use twice* (the same address in the same VRF on two devices, across designs,
     found through the estate index, which already indexes interface addresses).
   - Rejected: copying every drawn address into the store (two copies that drift), and refusing to
     draw an address that wasn't reserved first (a home lab or a teaching design would have to
     plan before it can draw).

3. **A reservation has a holder, a reason and an end.** *(card: Reservations, A)* A reservation is a
   prefix, a range or one address, held by a person or by a piece of work (a W-number, later an
   order's job), with a reason and an end date: 30 days by default, changeable by the person
   reserving. The holder is reminded a week before (in the Work tab, and by email once ADR-0085
   sends it). After the date it shows as *Lapsed*: still held, marked, and freed by its holder or a
   Steward with one click. A reservation linked to a piece of work becomes *In use* when its
   addresses are drawn, and is released when the work is cancelled. This answers the maintainer's
   point on #23411 (held resources exhaust a pool) without freeing anything nobody looked at.

4. **What the store covers.** *(card: What the first build covers, ticks)*
   - **IPv4 and IPv6** in one parser on both sides: the Rust `InterfaceAddress` scalar and a
     TypeScript twin tested against the same vectors. IPv6 next-free works on prefixes (a /64 out of
     a /48); for single addresses inside a /64 it offers the next free from the low end only when
     asked, and never lists 2^64 free addresses.
   - **VRFs**, each with its own space or with *enforce unique* (off by default, as NetBox does), plus
     the global table. A VRF in the store can be linked to a `RoutingInstance` in a design by name.
   - **The tree:** aggregate → container → prefix → range or address, nested automatically by
     containment within one VRF, with statuses Container, Active, Reserved, Deprecated (NetBox's
     four, so an export round-trips), *is a pool*, role, scope by folder, and a VLAN.
   - **Ranges**, such as a DHCP pool, with *populated* and *utilised* as NetBox has them.
   - **Next free**: the next free address, prefix of a given length, or VLAN ID in a group, skipping
     what is drawn in any design, reserved, or in a populated range.
   - **VLAN groups** with ID ranges and a scope by folder; IDs and names unique inside a group.
   - Not in the first build, unticked on the card: ASNs, NAT inside/outside pairs, DNS names on
     addresses, route targets between VRFs. Each is a later schema bump, not a redesign.

5. **Handing out the next free: on the server, once.** The server allocates under a transaction-level
   lock on the parent block, as NetBox does. Two things go further than NetBox today:
   - **Asking twice gives the same answer.** Every allocation carries the key of what asked for it
     (a work number and a slot, such as `W-1042/wan`), and the parent it came from. A repeat request
     with the same key returns the same block; the same key from a different parent is refused.
     This is what #23411 asks NetBox for.
   - **The database refuses a clash.** Each record's VRF and network go into a keyed hash (as the
     estate index's terms do), and a unique constraint on that hash, per VRF that enforces unique
     space, makes a duplicate impossible even if two servers race. The database learns which
     records share a network, the same cost ADR-0079 accepted for search.

6. **NetBox and Fathom: files both ways, no live link yet.** *(card: NetBox, A)* The importer
   already reads NetBox CSV and JSON (ADR-0067). It gains the plan kinds: a NetBox prefix, range or
   address export becomes plan records, previewed New / Match / Differ like today, through the
   redaction gate first. Export writes the store in NetBox's CSV columns, so a NetBox can be loaded
   from Fathom. Reading a NetBox server over its API would be a second outbound HTTPS client (ADR-0071
   allows the one, "to an outside vault and nowhere else"); it is an option on the card, not the
   pick.

7. **Where it shows.** *(card mockups)* Inventory › Addresses becomes the tree: one row per block,
   indented, with a used bar and the free stretches written out, and the next free of each length a
   click away. A block's panel shows what holds it, until when, how the usable count is worked out
   (a /29 is 8 addresses, 6 usable without the network and broadcast), and the addresses planned in
   it with the devices they're meant for. *Reserve* sits on every block and on a piece of work. The
   canvas marks a planned-but-not-drawn address in the plan colour on its interface, as ADR-0077
   marks an AI's proposed change.

## Schema

The store's kinds go into `schema/schema.yaml` as a new `plan` layer (they belong to an organisation,
not a design, and never emit config): `IpAggregate`, `IpPrefix`, `IpRange`, `IpReservation`, `IpVrf`,
`VlanGroup`, with `InterfaceAddress` and a new `IpNetwork` scalar for both families. One minor bump,
with its migration notes, before any code. The design graph's `Address`, `Vlan` and
`RoutingInstance` are unchanged; the link between a plan record and a drawn node is by value, VRF
name and the estate index, not a stored edge, so moving or deleting a device never orphans a plan.

## Order (once accepted)

1. Schema bump and the Rust store with its table, key label, lock and unique hash, with tests that
   two concurrent allocations of the same /29 get different blocks and a repeat key gets the same.
2. IPv6 in `ipam.ts`, tested against the Rust vectors; the derived views read both families.
3. Inventory › Addresses as the tree, Reserve, next free, the block panel.
4. The difference checks.
5. Import of plan kinds and NetBox-shaped export.
6. Orders (ADR-0084) use the store for their IP breakdown.

## Consequences

- One new table pair (records and their unique hashes), one HKDF label, one schema layer.
- The derived prefixes of ADR-0067 stay: a design with no plan behaves exactly as it does today.
- Key rotation re-encrypts the store in bounded batches, as the index does.
- `docs/decisions/README.md` gets this row when it is accepted (left out of the proposal so the
  six design threads open this week don't collide on the same line).
