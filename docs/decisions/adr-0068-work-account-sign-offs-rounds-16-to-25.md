# ADR-0068: Sign-off rounds 16 to 25: corporate mapping, circuits, Admin

**Status:** accepted 2026-10-15, rounds 26 and 27 added 2026-10-16 (owner answered the cards of rounds 16 to 25 on the sign-off page
kept on the work account, 14 and 15 October). Design decisions. Built since: one sign-in and adding people at once (point 1, ADR-0065), the Back tree (point 2, round 26 point 2), Equipment opening by itself (point 3, round 27 point 3) and missing links for cables (round 27); `docs/STATE.md` says what is on main. **Renumbered** from ADR-0065 on 2026-10-25: the number was issued twice (ADR-0065 is one sign-in), and 0066 went to learning, lessons and Ansible.

**Context.** The owner works on the corporate network at an ISP. The first use at work is the
owner mapping datacenters, closets and UPS rooms; circuit design is the second group. Practise on the
home lab: **no corporate data on the home server** until Fathom runs on a server at work and #104
is closed.

## Decided

1. **Sign-in and people** (draft PR #163). Read and Draw members join at once, with no code compare;
   stewards still confirm. Admin re-asks for the code once per sign-in. A browser approved for Admin
   by email is trusted for 7 days by default, once mail exists.
2. **Back button** (draft PR #161). One Back button naming where it goes, with a small ▾ beside it
   that unfolds a tree of where you are inside the design. Past six levels, show the top two and
   the last three and fold the middle. The top bar's path stays as it is (where the design lives).
3. **Equipment panel.** Opens by itself on an empty design; an "Add equipment" button on the canvas;
   the empty-design hint names the correct side (the code says right; an old card said left).
4. **Engines.** An Engines page in Admin: version, what it reads, model count, who checked it and
   when; add from a repository or an uploaded file, update, remove; only signed engines load
   (ADR-0044). Vendor order: Adtran, Calix, Nokia, Juniper, Cisco, Arista. Some of that equipment
   is configured only through a web interface: those engines are catalogue models plus import from
   what their management systems export. Name no specific customer-premises model in the
   repository until the catalogue lists several.
5. **Admin rework, one bundle.** Left-hand section list: Health (the landing), Security, History,
   Engines, Server, Mail. One-line tips behind a **?** button (works on phones). Keep all wording
   short. **People and roles stay in Organisation**: operators cannot grant (admin §1, §3).
   - **Health:** tiles for server, backups, key file, disk, save history, mail. Fathom cannot see
     backups or the key-file copy, so those tiles show when the operator last ticked them off.
     A tile needing attention turns amber, and so does the Admin pill.
   - **Security:** a short fixed list of signals, each switchable (many failed sign-ins, Admin from a
     new address, unusual hours, a new operator). It flags; a person decides. Never an automatic
     lock-out, which could be used to lock out the stewards.
   - **History:** a filterable timeline (who, kind, date range), grouped by day, with bursts folded
     into one line. Exports to a logging server as syslog and JSON lines (#49). Admin shows sign-ins
     and server events only; people's activity in designs is the stewards', under Organisation.
6. **Sites: a third place** beside Canvas and Inventory, on the same live data. Quick view and quick
   actions only (add a rack or device, rename, move a rack, photos, print labels); cabling stays on
   Canvas, bulk edits in Inventory.
   - A site lists its **rooms**: a fixed kind list (datacenter, closet, UPS room, meet-me room)
     plus Other. Each room is a bold, foldable bar showing racks, free space and warnings; the room
     used last starts open. Open, it shows a light floor layout.
   - Racks sit by **row and position** fields first; many racks are grouped by row, with filters
     (has free space, has warnings).
   - Opening a rack shows its units and quick actions. **Canvas from a rack opens inside that
     rack**; Canvas from a site opens on that site, zoomed to fit; Back returns to Sites.
   - The floor plan is the canvas. An uploaded image or PDF as a backdrop comes first; drawing the
     plan from the image automatically stays research (#45).
   - Map racks, patch panels, links between rooms and buildings, UPS → PDU → device power, incoming
     carrier circuits, and photos (an icon, collapsed by default).
7. **Circuits** (design agreed; built after the mapping work). A circuit is its own record with an
   ID, listed in Inventory and traceable.
   - Templates are written by stewards and people they choose. On the canvas a template looks like a
     **stack of cards**, folded until opened.
   - Inventory gets a **Circuits** kind; a circuit's page lists its links as rows to type, paste or
     copy. Build the rows first, the canvas template second. `*` when pasting means Planned, shown
     as a Status column. A pasted write-up always lands as a plan that someone accepts.
   - Connecting **always asks** which port, from the site you are in.
   - **Open ends:** a link names its far device and leaves the port for install day. People who can
     draw fill it; readers send it in like a cable correction (#125). The circuit stays "Waiting on
     install" until filled. **How an open end looks is undecided:** the owner turned down a dotted
     link, a loose plug, a flag and a blinking port.
8. **Labels.** Fathom draws labels itself, QR code included (`client/src/qr`), and prints them from
   the browser on a tape printer or on plain paper with cut lines. No label software, so it works on
   Linux. Labels for racks, devices, both cable ends, patch panels and room doors. A scan needs
   sign-in and opens a phone page: what the item connects to first, a collapsed photo, "Label wrong"
   and "Not here". A public read-only scan view is a later idea: off by default, switched on per
   organisation by a steward, chosen fields only, every view logged, and a security review first.
9. **Order after the Admin rework:** cable groups (#54), then organisation-wide tags (#55) built
   with sites and rooms.
10. **Motion and polish.** Short, quiet motion that fits the flat look (unfold, fade, a small pop on
    selection) and turns off under `prefers-reduced-motion`; one alignment pass across the app.

## Inputs for later

- **Sources at work:** NetBox (the importer reads it), Lucidchart (CSV export, untested), a tool
  called NCS (export format unknown), and CLI on core gear (config paste, once those engines exist).
  Mapping happens at a desk.
- **Parked by the owner:** the Lab walkthrough and the reading and signing of vendor pages and
  Checks rules (round 13).
- **Draft PRs** #150, #153 to #156, #159 to #161 and #163: the owner decides later.

## Round 26 (16 October, home sign-off page)

The owner answered the cards that closed the gaps between this record and the code.

1. **This record goes on main as written** (merged as #164).
2. **Back button:** the ▾ tree from point 2 is added, and the visible Forward arrow is dropped. The
   go-forward shortcut and the mouse's forward button still work.
3. **Admin gets an Accounts section**, second in the list after Health. It holds people on this
   server, operators and links issued. Organisations moves under Server, and today's Settings tab
   splits between Server and Mail. This adds to point 5's list. People and roles inside an
   organisation still stay in Organisation.
4. **Drafts:** #150, #153 to #156, #159, #160 and #163 are merged (as #165, schema 0.21 to 0.23).
   #161 lands with the ▾ tree.
5. **Order: mapping first.** This replaces point 9. The equipment panel fixes come first, then
   Sites with rooms and tags (#55), then labels and the scan page, then cable groups (#54), then
   the Admin rework, then Engines, then Circuits. Further decisions from the work account may
   still reorder this; nothing past the equipment panel fixes starts until they are in.
6. **Open ends (point 7), decided.** The missing stretch of the link is slanted amber dashes that
   crawl toward the far device, with a **?** in a circle in the middle of the gap. The whole **?**
   swings from its centre every few seconds; the circle stays still. Both stop under
   `prefers-reduced-motion`. In place of a typed to-do, Fathom finds the missing links itself and
   lists them in Canvas, Sites and Inventory: open ends on circuits and cables with only one end
   plugged in, not patch-panel ports used on one face.
7. **Three places.** Canvas, Sites and Inventory are the three views. Anything listed "everywhere"
   (missing links, warnings) covers all three.

## Round 27 (16 October, home sign-off page)

1. **Two kinds of missing.** A loose end is either **Needs finishing** (planned or unfinished work:
   the look in round 26 point 6, counted in a **Missing links** count in the top bar) or **Unknown**
   (a legacy drawing where nobody knows the far end: the line fades out, no motion, "Far end
   unknown" on hover, not counted). A loose end starts as Unknown until someone marks it Needs
   finishing; a circuit's open end always starts as Needs finishing. Unknown ends sit in a folded
   section at the bottom of the Missing links list. The count hides when nothing needs finishing.
   Every **?** that marks missing information is drawn at one size.
2. **Missing links is built now, for cables.** Circuits join it when they are built.
3. **Equipment** opens by itself on an empty design only until it is closed once on that design.
4. **Back tree:** with the ▾ tree open, a click on empty canvas folds the tree and keeps the
   selection.
5. **Port ties suggest from cited pages.** Juniper EX from Juniper's EX naming page, Juniper SRX from
   the SRX300 and SRX340 configuration pages (on-board ports 0/N are ge-0/0/N), and every EdgeRouter
   from the quick start guides for the ER-8, ER-X, ER-X-SFP, ER-4, ERLite-3, ERPoe-5 and ER-12, all
   read 2026-10-16 and accepted by the owner (`corpus/dict/port-names.json`). The ER-6P guide could
   not be opened.
