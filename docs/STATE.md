# What is actually built

**Last confirmed:** against main at b5db647 (PR #336, the combined drafts), 2026-11-12. Counts are not
kept here: read them off a real run (`fathom-schema-check`, `ls crates/fathom-server/migrations`,
`./scripts/gate-zero.sh`). Schema version: the `version:` line of `schema/schema.yaml` (priced in
`docs/SCHEMA-HISTORY.md`).

This page records what exists on main. It is not a changelog; history lives in `docs/archive/` and in
`git log`. Each entry names where to look: the ADR that decided it, the code, and the drive script that
proves it. Sign-off cards (`rNN`) are on the Sign-offs page, not in the repository.

**Status: not yet "usable".** That word is the owner's and means beta. For alpha, nothing is hidden: the
parts below marked **server only** have no screens and are meant to carry a "Not finished" mark.

---

## Engine

Rust crates under `crates/`: schema toolchain (`fathom-schema`, `-schemagen`), typed graph (`-graph`,
`-id`), config ingest and the redaction gate (`-ingest`), weld, finder, emitters, layout, rules
(`-rules`), inventory and path trace (`-inventory`), workspace and compaction (`-workspace`), orders
(`-orders`), and `fathom-wasm`, which runs the same engine and gate in the browser. The redaction gate is
never reimplemented in JavaScript. A field that is not in `schema/` does not exist.

**Paste.** Ten platforms, each with a dictionary or front end under `corpus/dict/` and a README that cites
its sources: Junos SRX and EX, EdgeOS, OPNsense (rules CSV and `config.xml`), pfSense (`config.xml`),
MikroTik RouterOS (`/export`), Linux host (`ip addr`, `ip -d link`), TP-Link switch, UniFi switch (built on
EdgeSwitch syntax, unverified against a real UniFi config) and Arista EOS (including VRFs). A paste names
its platform or the engine detects it from lines only one dictionary binds; unsure is
`ERR_PLATFORM_CHOICE`, never a guess. XML dictionaries are allowlists: any value no entry describes is
destroyed. A password inside a URL (`scheme://user:pass@host`) is destroyed too. The paste frame and the
"Which device is this from?" picker name all ten.
Known gaps: ADR-0044's redaction-unproven refusal is not built (the core floor is the only fence); a
credential in the free-text description cell of the OPNsense CSV is not caught (pinned in
`opnsense_csv.rs`); a dictionary cannot bind `lacp_mode`, an interface form or a `NextHop`; how EdgeOS
quotes a value holding a space is not established from a source; the Junos ELS MAC table is not read.
**Typed values are not redacted:** the gate runs on paste only, and a password typed by hand is stored as
written, with a warning mark. A paste creates no cables or ports; ports are drawn or patterned and cables
drawn or accepted from a neighbour-list suggestion.

**Catalogue and engines.** Equipment models are YAML in `corpus/catalogue/` (read by the server at start;
`ls` is the list). Engines are files in the tree: ADR-0044's signed packs, install and pinning are not
built. Every explainer's `reviewed_by` is a placeholder, so Learn says *Unreviewed* on each.

**Checks.** The engine checks the open design in the browser against the written rules in
`corpus/rules/` (addresses on a link, VLAN access and trunk, cable media, link speed, one cable per port,
power and single-cabled switches, stock below minimum, firmware behind). Every rule's reviewer is `pending: Key
Maker`. The server runs no checks.

**Path trace** (ADR-0061 item 9; `fathom-inventory/src/trace.rs`, `OP_TRACE`, `scripts/drive-trace.mjs`).
Walks cables, patch panels, VLANs at switches, routes (connected beats static of equal length, longest
prefix, VRFs and `next-table` hand-offs), SVIs, LAGs, PON splitters, firewall zones and policies in order
with "matches / doesn't / can't tell", route-based IPsec through `st0`, hand-entered mesh VPNs, and Junos
SRX NAT (static, destination, source, in Juniper's order). Never a verdict; it stops at the first thing the
design does not state ("could not establish"). Not read: learned routes (OSPF, BGP), exit nodes, NAT on
traffic the start device itself sends, an unnumbered `st0`.

**Work clashes** (`fathom_inventory::work`, `OP_WORK_CLASHES`; r105 part 1). A plan lists other plans and
open issues on the devices it touches when windows overlap; it warns and never blocks. Across designs,
one person on two things, and orders are not built.

**Orders** (ADR-0084; `crates/fathom-orders`, `corpus/orders/`). Reads order and field-set definitions and
runs one order by replaying its actions. **Server only:** `orders.rs`, migration 0075, routes under
`/organisations/{o}/order-types` and `/orders`. No screens, no overdue clock, no `holds` in the clash check.

---

## Server

`crates/fathom-server`: Axum on PostgreSQL, one published plain-HTTP port behind the operator's TLS
proxy, serving the web client itself (`client.rs`). It refuses to start on a broken schema (exit 7) or if
its database role is a superuser or bypasses row-level security.

**Storage and keys** (`docs/PHASE-2-STORAGE-DESIGN.md`, ADR-0043). A master key (file, `command://` or
`env://`) wraps a per-tenant key, which wraps a per-design key; designs are ChaCha20-Poly1305 with random
nonces. Every version appends an HMAC-sealed chain entry; verification reports verified, broken at N, or
cannot verify under epoch K. Chains exist at site, organisation and design level; sealed entries ship as
RFC 5424 syslog to an operator destination, spooled in PostgreSQL when it is down. Organisation names and
scope paths are plaintext (storage §11.3 name encryption is not built). The server can read design data
while running, and says so (storage §2a). `tests/no_key_protected_data.rs` sweeps every table for a
marker written through the real write path.
Tenant isolation is an application filter plus row-level security from a transaction-local setting.
Migrations are in `crates/fathom-server/migrations/`; an applied one is never edited. Two custodies:
operators hold the machine, stewards hold the data (migrations 0004, 0005).

**Authority** (admin design §3; `authority.rs`, `grants.rs`). Signed grants (ES256), seconding, suspension,
revocation, an authority head whose digest covers the whole state, sole-steward flag inside the signed
bytes. Teams (ADR-0081; `teams.rs`, `roles.rs`; attacked in `docs/TEAMS-ATTACK-ROUND.md`), team roles
with fixed powers, and plan approvals (`plan_approval.rs`) are signed acts in the same head. Not built:
Shamir shares, WebAuthn/passkeys, an operator suspending an account, work assignment through teams.
Sessions are signed messages with single-use nonces (`sessions.rs`): 1 hour idle, 12 hours at most; Site
access needs a verification code under 15 minutes old (ADR-0057). Every server answer is `no-store`.

**Operator plane** (ADR-0055, 0057). The notice address is the identity; sign-in is address, password
(argon2id, 15 to 128 characters) and an authenticator-app code, plus ten recovery codes. The setup
password opens setup once for 30 minutes. Quorum is `min(2, live independent operators)` at every act.
Break-glass is `fathom-server recover-operator <address>` on the host. The console can place itself on its
own host or from `FATHOM_ADMIN_HOSTS` / `FATHOM_ADMIN_SOURCES`. A client's address is one rule everywhere
(`client_address.rs`; `X-Forwarded-For` believed only from `FATHOM_TRUSTED_PROXIES`). Every console and
sign-in request writes an `access` line (`access_log.rs`, optional `FATHOM_ACCESS_SYSLOG`). The
forgot-password route answers before it issues its token, so its timing does not tell an address that has
an account from one that has not.
**Not built:** sending mail. SMTP is a console setting with no mail client behind it, so there is no reset
or notice by mail (ADR-0085 is design only; server-side email has no screens). The console's second-operator
signature for two-person verbs; handing a requested colleague their setup token.

**Estate index and sites** (ADR-0079; `estate.rs`, migrations 0058, 0068). After a save the server
rebuilds a design's rows (devices, cards, optics, supplies, spares, plans, issues) five seconds after it
goes quiet, sealed under a derived key, searched by keyed hashes, filtered by the caller's Read at the
time of asking. Ctrl+K shows **Other sites**, Inventory **Every site**. An `ExternalPeer` can name a far
design and port; Checks warn when the far end is gone or one-sided. Each checkpoint keeps the newest 500
changes (Undo reaches those); history pages from the server. Scale and HA: `docs/SCALE.md` (measured),
ADR-0089 and ADR-0090 (design only, nothing built beyond the index changes).

**Work tab** (ADR-0087; `components/work/`, migration 0064). Plans, issues and spares from every design the
caller may read, with Fathom numbers `W-42`, never reused; refreshes every five seconds while shown.

**IP plan store** (ADR-0083; `ipam.rs`, migration 0065, schema layer `plan`). **Server only:** eleven
`Ipam*` kinds as sealed records beside the designs, with Next free under an advisory lock, reservations
that lapse, and routes under `…/ipam/`. No screens, no difference checks, no NetBox files.

**Live co-editing** (ADR-0063; `live.rs`). Changes are signed requests applied to the server's head
through the engine, then numbered, chained, encrypted and streamed. Different fields merge; on the same
field the later wins and the overwritten person can **Put mine back**. Presence and changes cross server
processes through PostgreSQL `NOTIFY`, so several servers behind one balancer need no sticky sessions
(`docs/RUNNING-IT.md`). Nothing exercises two genuinely concurrent saves (a row lock serialises them).

**Password vault** (ADR-0042, 0071; `vault.rs`, `vault_fathom.rs`, `vault_breach.rs`, `vault_outside/`,
`client/src/vault/`). Sealed in the browser (Mode A) with an Emergency Kit and passphrase; Mode B lets
Fathom itself use a login the owner consented to (second admin countersigns when shared; every use files
`vault_read` first); breach checks run in a holder's browser against the Have I Been Pwned range API with
five hash characters; outside vaults pull from Vaultwarden, Delinea Secret Server and Passbolt (OpenPGP in
a separate helper, `helpers/passbolt/`). An outside vault URL on a private or special-purpose address is
refused unless the operator lists the host (`FATHOM_OUTSIDE_VAULT_HOSTS`; IANA special-purpose
registries), and every failure on an unlisted host reads the same. Delinea and Passbolt are tested
against stand-ins of their documented shapes, never a real server. Not built: the chain verifier's check
that a `vault_read` names a login then in Mode B. `scripts/drive-vault.mjs` sweeps a superuser `pg_dump`
for every secret.

**Device reading** (ADR-0082; the reader is a separate helper, `helpers/reader/`, compose profile `reader`,
`scripts/gate-reader.sh`; `device_read*.rs`, `device_reading.rs`, migrations 0067, 0073, 0077). The operator
allows it with `FATHOM_DEVICE_READ=on`; a Steward turns it on per organisation and lists management
ranges (loopback, link-local, multicast and reserved addresses refused whatever is listed). It reads
only, never writes or acts:
- **SNMPv3** (Fathom's own, GetRequest, GetNextRequest, GetBulkRequest only; authPriv with HMAC-SHA-512,
  -256 or -96 and AES-128; no MD5, DES or Set): system, entity inventory, interfaces, LLDP, MAC and ARP.
- **SSH** (russh; a platform's fixed commands): the configuration, through the gate in the reader and
  again on the server, kept sealed as the newest ten. A read is incomplete unless the device ended its
  output; connecting gives up after 15 s.
- **Identity first:** before any login is sent, the SNMP engine ID or SSH host key must be confirmed (last 8
  characters typed by someone with Draw, or a Steward approving a range). A range's login over SSH waits for
  a host key a Steward confirmed; a changed one stops reads until confirmed alone.
- The device panel shows a "differs from drawing" chip and a Readings tab; Accept, Add and Add cable are
  ordinary edits. Attacked in r117 (fixes merged with #337). Not built: scheduled reads, logins by folder,
  port descriptions, site readers (ADR-0089).

**AI access** (ADR-0072, 0077; `ai.rs`, `oauth.rs`, `mcp.rs`, `ai_change.rs`). A person a Steward names lets
an AI app read the designs they can read at the tiers the organisation allows (layout, addresses, notes),
never passwords or the vault, and send ideas a person accepts. The connector is Fathom's own OAuth 2.1
server plus `/mcp` (needs `FATHOM_AI_PUBLIC_URL`); the helper is `client/public/fathom-ai.mjs` with an
ES256 key. An AI never writes a design: with two ticks it may propose a change, kept sealed in an idea and
shown on the canvas as an open plan; accepting makes it the person's own edit. What it may do is set by
kind of work at three layers (Admin ceiling, Steward rules, each connection), strictest wins.

**Termix** (ADR-0078, 0080; `termix.rs`, `components/termix/`). Optional, off unless `FATHOM_TERMIX_URL` is
set: open a device's terminal, send hosts, snippets, maintenance windows, and a check step that can fetch
its own read-only output. Proved against a real Termix in CI (`termix` job).

**Firmware** (ADR-0045, 0064; `firmware*.rs`). Staged images with SHA-256, SHA-512 and MD5 (MD5 never
compared), re-hashed hourly and at every download; limits set from the settings file, **Admin › Firmware**
and **Steward › Firmware**; the Firmware permission sits between Draw and Steward; one-time links; retire;
plans with vendor steps for Junos, IOS XE, NX-OS, EOS and written steps for OPNsense, Debian, Ubuntu,
TrueNAS and Synology DSM (marked not checked). Not built: the firmware check on spares.

**Other server stores.** Cable corrections from the floor (`corrections.rs`, 0036); field definitions
(0035); folder place and kind (0050) and `design_moved`; teaching setting "Type it yourself" (0041);
faceplate templates and each person's Cables lists, sealed (0076; both merged in #333); the Activity
trail on the console (`admin.rs`).

**Backups** (ADR-0070). A data file and a keys file (sealed under a recovery phrase through Argon2id),
`fathom-server backup | keys-file | restore | dump-from`; in compose a `backup` service makes one nightly
(keeps 14) and restore-tests weekly; the `offsite` profile copies to S3-compatible storage. Admin ›
Settings › Backups shows the state.

**Running it.** `docker compose up -d` from the root with one variable in `.env` (`docs/RUNNING-IT.md`),
run end to end by CI's `compose` job. `publish.yml` pushes `ghcr.io/keyxmakerx/fathom-server` and
`fathom-backup` on every merge to main; `release.yml` and `scripts/release/pin-compose.sh` build a compose
file with every image hashed. No alpha tag has been cut. Keys are generated by the `db` container's start.

**Dependency gate.** Layers: approval records per crate, licence and source allowlists with duplicate
bans, RustSec, lookalike names, a publication cooldown, and `scripts/osv-gate.sh` (needs egress to OSV.dev;
fails closed, and cannot run from every environment). `scripts/gate-reader.sh` and the Passbolt helper
have their own. Server crate cap 200, revisit at 180.

---

## Browser client

`client/`: React, Vite, React Flow (`@xyflow/react`), plain CSS; the only runtime dependencies are React,
React DOM and React Flow (About Fathom lists every shipped library with its licence;
`scripts/licences-npm.mjs` fails CI on a drift). Look and
layout are in `docs/UI-SPEC.md`, ADR-0060 and ADR-0061. The redaction gate runs in the browser
before anything from a paste is stored or sent.

**Sign-in, Home and the console.** First run takes the setup token, address, password, authenticator app
and recovery codes (ADR-0056); `SignIn.tsx`, `Enrol.tsx`, `InviteWhileSignedIn.tsx`, `Reset.tsx`. Home has
tabs Designs, Work, Teams, Passwords, Steward, AI and Admin, each shown only to someone who may use it. The operator
console (`components/console/`) has Accounts, Organisations, Operators and Settings. ADR-0068's Admin
rework (Health first, section list, Engines) is decided, not built. People and access are added by link
(Read or Draw at once; a Steward is invited and confirmed by signature). Not built: removing access given
to a whole organisation, making an existing member a Steward.

**Folders and places** (ADR-0074, 0051; `components/places/`). A site, building or closet has a kind and a
role (hub, branch, customer); zoom stops above the closet draw the folders as boxes (grid, not hand
placed); a building's floor plan is traced over an uploaded picture. A steward of both folders moves a
design. Import from NetBox on Folders (`scripts/drive-folder-place.mjs`). Not built: PDF plans, DXF, door
labels.

**The canvas** (ADR-0060). One canvas, detail by degrees: closet 87.5%, rack 100%, faceplate 200%, inside
300% (max 400%). Racks with rails and U numbers, rear elevation (ADR-0050), shelves, walls and free boxes
(ADR-0051), cables that hang, bundle and light their whole path, portals for cables leaving the closet,
cards and optics (ADR-0073), power supplies. Marquee, copy, duplicate, align, nudge. A device whose rack
spot is unknown is a free box with its whole self. Look switch: **Rack** or **Diagram** (plain labelled
boxes, square lines). Every change saves (one in flight, latest queued; a refusal is shown, never rolled
back). Not built: line routing, touch marquee, "in this rack, spot unknown".
Controls: a back button with a tree of where you are (`JumpTrail.tsx`), a quick card on click, a peek on
pause, one grouped right-click menu per kind of thing (same in the panel's ⋯, Ctrl K and Inventory rows),
the device panel (Details, Ports, Notes, Readings, Routing; **Also in** at its foot; Esc closes only the top
thing), "Swap model, keep ports", "Not here? Describe it", a keyboard shortcuts button in the bar.
`docs/UI-SPEC.md` is the spec; the audit of 2026-11-11 found controls scattered and a right-click menu too
long, and a layout rework is waiting on the owner's answer.

**Show menu and lenses.** Layers on the drawing (Checks, Addresses, VLANs, Docs, Maintenance, Tags, VPNs),
cable style (Physics, Cable-tied, Right-angle, Faded), device style on Diagram (Boxes or Icons). Lenses:
Links (VLAN colour, hollow trunks, weight by the slower end's speed; nothing sets `Interface.speed` by
hand yet) and Routing (what a box routes or switches, gateways, a Table picker for VRFs, a Routing tab).
All per browser and design, never saved in the design. A path trace also draws on Diagram.

**Inventory and notes** (ADR-0053, 0058, 0059, 0062, 0067). Two places over one document: Canvas and
Inventory (rail of kinds, grid per rack, Gaps, one page as the editor, Show on rack; coming back finds it as
left). Kinds include Devices, Parts (cards, supplies, optics, On hand, stores and levels per ADR-0076),
Networks (VLANs, subnets, Docker networks, VPNs, Routes by hand), Firmware, Models, Tags (rename or delete),
Issues and Passwords. Organisation-wide custom fields (migration 0035). One importer (CSV, NetBox, Proxmox,
nmap). Tags are chips on most things and search finds them. Notes are nodes, pasted through the gate or
stored as typed and saying so. **Undo** is a new batch of reversing operations: only your own, a
colleague's later change refuses by name. **Docs** (Markdown subset, files up to 25 MB, text gated in the
browser, images and PDFs need a per-file confirm). Not built: a Docs kind, private fields, saved filters
and grids for racks, cables and ports.

**Paste and suggestions.** Paste a config anywhere (`components/paste/`): a card names hostname, platform,
interfaces and what the gate destroyed by kind, never values; nothing is stored until chosen. A dropped
folder of configs matches files to devices by hostname. Neighbour lists (`show lldp neighbors`, CDP), MAC
and ARP tables, DHCP leases and `show version`/`show inventory` output *suggest* cables, hosts, serials and
versions (ADR-0046: suggestions, never facts; one undo step). Port ties join a pasted interface to a drawn
port, made by a person, suggested only from a cited naming rule.

**Plans, It's down, lessons.** Maintenance plans (ADR-0061; Plan, Do, Record): typed steps, a LAG step,
If paths, release notes, Back out, After the work checks, Call it off, firmware plans, Termix helpers; Move
mine and Let them know from clashes. **It's down** is a checklist from a device (power, neighbours, link,
port, address, gateway) that can be saved as an issue and picked up again. Learn (ADR-0066): explainers
(`corpus/explainers/`), Learn notes on Diagram, guided lessons (`corpus/lessons/`) checked by the page's own
engine, a lesson builder, and the sample home lab (`corpus/samples/home-lab.json`) with five first steps.
Not built: the Run Ansible lesson step, explainers for Cisco and MikroTik.

**Sharing, printing, phone.** A steward's **Share** gives View or Draw to people already in the
organisation (no outside invites or public link). Print pack: This view, Rack elevations, Cable schedule,
Port map (.csv or .xlsx), the Inventory table, then the browser's Save as PDF. Labels print a QR code
(`/scan#<design>/<id>`) for devices, racks, cables, ports and bins on Brother TZe, QL or A4. Under 760 px
wide the phone field view shows Scan, Find and a read-only Canvas (ADR-0075); the full top bar is not yet
usable at phone width. Add to Home Screen works; there is no service worker.

**Missing links, history, cable corrections.** A one-ended cable draws as a faded or amber "needs
finishing" column and the bar counts the latter. **History** leads with the chain check in words and
**Restore this version** (Draw) makes a new save. Cable corrections ("Traced ✓", "Label wrong", "Not
here") wait for a Draw person's accept or dismiss.

---

## Never built

Walkthrough view and Config view; a room stop of its own; engine manager; automatic correlation across
separately pasted configs; anything that discovers a network live (everything comes from pasted or read
text); the Rust-assembled HTML client is retired and not served (`crates/fathom-artifact/`).

## Known limits worth remembering

- **The test suite needs a fresh database** (`docs/NEXT.md` rule 3). Reused, it fails intermittently;
  `tests/operators.rs` leaves a `fathom_isolated_*` database behind per test.
- **The server's credential check is the detector only;** SNMPv3 auth and priv values are a known residual.
- **People and access, residuals:** an operator-issued token for an account can be redeemed after a steward
  confirms that account; confirm checks nothing about the joiner's password or app code; the daily cap of 50
  invitations is per steward per organisation.
- **Trail and notes:** the sealed mark is an idle-time approximation; a note's line count is taken before
  the gate; private notes wait for the vault.
- **Corrections** have no chain entry and no retention clean-up of decided rows.
- Wire shapes have no cross-language vector yet.
- **Unreviewed content:** every rule and explainer says so until a named person reviews it.
