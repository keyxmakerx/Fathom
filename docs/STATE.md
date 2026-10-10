# What is actually built

**Last confirmed:** 2026-10-02: 1561 Rust tests and 1531 client tests on commit 3b10bfc, read off the runs. Prose brought up to main (40f0fea) on 2026-10-10; counts not re-read. Read numbers off a real run, not off this page.

This page records what exists. It is not a changelog — history lives in `docs/archive/`.

---

## Working and keeping

**The Rust engine.** Schema toolchain, typed graph store, config ingest with the redaction gate, the
fragment-to-store weld, the finder, emitters, layout. Zero external dependencies on the client side,
deliberately. The schema is real and enforced; read counts off `fathom-schema-check`.

**Paste, four platforms (engine).** The wasm shell holds every dictionary at once, keyed by platform
(Junos SRX, Junos EX, EdgeOS, OPNsense). A paste names its platform (frame flag byte, bits 1-3) or the
engine detects it from lines only one dictionary binds; unsure is `ERR_PLATFORM_CHOICE` with the
candidates, never a guess. `OP_REDACT_TEXT` runs every set-form dictionary. A paste into a device reads as that
device's platform; otherwise, when the engine cannot tell, the card asks "Which device is this from?" once.

**The server.** `crates/fathom-server` starts, answers a health check through a real PostgreSQL, shuts
down cleanly, and runs as the one plain-HTTP published port of a composed stack, behind the operator's
own TLS-terminating proxy. It stores identity and structure (accounts, organisations, memberships, the
organisation → network → building → rack tree), encrypted designs, and encrypted audit chains with a
spool that ships sealed entries for external custody.

**Encrypted design storage** (migration 0007). A master key (file, `command://` or `env://`;
ADR-0043 §3) wraps a random per-tenant key, which wraps a random per-design key. The design key
encrypts the payload whole with ChaCha20-Poly1305 and a fresh random 96-bit nonce. Per-design keys are
mandatory: the birthday bound on a random nonce is the whole safety margin, and one key per design
makes it irrelevant.
- The master key's non-secret id is stamped into the database, so restoring beside the wrong key file
  names both keys instead of an AEAD failure that reads like corruption.
- Every version appends an HMAC-SHA-256 sealed chain entry binding plaintext and stored bytes.
  Verification reports **verified**, **broken at entry N**, or **cannot verify under key epoch K**; a
  links-only run says *content not re-bound*.
- Rotation re-encrypts and writes `reencrypt` entries. Re-wrap is deployment-wide in one transaction
  (0010); re-wrap of one tenant is not built (§12.6 needs a tenant-level chain that does not exist).
  Re-wrap and rotation have separate columns and words. Custody switches by re-wrapping keys.

**Migrations** (design: `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md`, `docs/PHASE-2-STORAGE-DESIGN.md`):
- **0003:** every RLS policy split by command, so the branch that lets an account see its own
  memberships never serves a write.
- **0004, 0005: two custodies.** Operators hold the machine; stewards hold the data. A composite key
  onto `principals (id, kind)` makes an operator unrepresentable in an authority row, proved as
  superuser. The operator role has `SELECT` on eleven tables (`OPERATOR_MAY_SELECT` in
  `tests/planes.rs`), every policy for it `FOR SELECT`. The application's database password is
  generated at first start into the key volume, in neither compose file nor environment.
- **0006: roles.** The migration role owns the schema (`CREATEROLE`); the runtime role `fathom_app`
  has data privileges only and serves every request. The server refuses to start if its role is a
  superuser or bypasses row-level security (§15.0).
- **0008:** verification checks everything checkable first and reports a coverage gap beside the
  result (§12.6a); the storage pass is entry-driven both ways (a payload row no entry names is a
  break). A design with a sealed history, stored version or key cannot be deleted by anyone, superuser
  included. The chain master carries the stamped key id.
- **0009: chains at site, organisation and design level** (`chains` module). The `audit` module (§9)
  ships sealed entries as RFC 5424 syslog over TCP to an operator-configured destination, spooling in
  PostgreSQL when it is down. The append-only fence is a trigger and binds a superuser
  (`tests/append_only_fence.rs`). The `keys` module holds **organisation content keys**, wrapped under
  the tenant key, encrypting organisation-chain metadata. Organisation names and scope paths are still
  plaintext (storage §11.3 name encryption is not built).
- **0010:** an entry's type must belong to its chain kind. The spool is bounded (admin §9): past it
  design writes stop, reads continue. `tests/chain_vectors.rs` holds golden values from an
  independent Python assembly.
- **0011: the authority layer** (admin §3). Root-key identity, account signing keys, scope grants with
  signature columns, seconding, suspension and revocation (append-only), the authority head.
  `authority.rs` holds the signed-byte constructions, `grants.rs` the acts; ES256 software keys,
  verified at every use, nothing cached (`p256`, `ecdsa`: records under `deps/decisions/`). Genesis is
  real; Shamir shares, WebAuthn, the admin surface and groups are not built. Admin §3.2 lists eleven
  departures from the design text. Vectors: `tests/authority_vectors.rs`.
- **0012** (admin §3.8): the head's digest covers the whole authority state; every seconding is
  verified at use; granting is propose-then-sign; suspension cannot manufacture a sole steward; expiry
  is evaluated at use; the sole-steward flag is inside the signed grant bytes (`fathom/grant/v2`). It
  refuses to apply over a pre-release database with enrolled keys: recreate it.
- **0013: sessions** (`sessions.rs`, `api.rs`; admin §4). A signed message on every request that
  reaches design payload or vault ciphertext, single-use nonces, a browser-held session key, a MAC
  under a site-scoped row key.

**The server can read design data, and says so** (`docs/PHASE-2-STORAGE-DESIGN.md` §2a). Encryption
protects the database, backups and disk, not the running process. `tests/no_key_protected_data.rs`
requires every table to declare whether it holds key-protected material and under which key, and a
marker written through the real write path must appear in no column of any table (a positive control
proves the sweep can find one). The credential vault is not built.

**Tenant isolation holds at two layers:** an application filter in every repository function, and
PostgreSQL row-level security driven by a transaction-local setting (never session-level: a pooled
connection would carry it to the next request).

**The engine seam.** The server depends on `fathom-schema`, `fathom-graph` and `fathom-id`, loads the
`schema/` tree once at startup and serves `GET /schema/kinds` from it. `fathom-graph` and `fathom-id`
have no caller yet.

**The dependency gate.** Six layers: approval records per crate; licence and source allowlisting with
duplicate-version bans; the RustSec check; lookalike-name detection; a publication cooldown; and
`scripts/osv-gate.sh`, which sends every (name, version) in the lockfile to OSV.dev because two real
advisories were missing from RustSec alone (storage §12.5). It fails closed when the API is
unreachable, as it is from this environment. Read the crate count off `./scripts/gate-zero.sh`.

**The operator plane (ADR-0055, amended by ADR-0057).**
- The address is the identity: first start creates an account for `FATHOM_OPERATOR_NOTICE_ADDRESS` and
  binds operator custody to it (`operator_account_bindings`). Sign-in is that address, a password
  (argon2id, 15 to 128 characters) and a verification code from an authenticator app (RFC 6238 TOTP,
  SHA-1, six digits), plus ten hashed recovery codes (`credentials.rs`, 0018).
- The setup password in `.env` opens setup once for 30 minutes after start and is spent when the first
  operator's password is set (0027).
- `FATHOM_SINGLE_OPERATOR` is retired. Quorum is `min(2, live independent operators)`, counted at
  every act, so a sole operator adds a colleague alone after the 24-hour delay (0019, `operators.rs`).
  With one live operator the server warns at every start and the console banners it; work is not
  blocked.
- Break-glass is `fathom-server recover-operator <address>` on the host: no delay, a sealed
  `operator_recovered_from_host` entry, a banner on every operator session for seven days.
  `reissue-bootstrap-token` is a deprecated alias.
- A deployment first started before ADR-0055 is adopted on first start (0026): the bootstrapped
  operator is bound to the install address, old keys and sessions retired, one sealed
  `operator_adopted` entry, same setup token file.
- The console can place itself on its own host (confirm-or-revert, five-minute default window), or
  from `FATHOM_ADMIN_HOSTS`/`FATHOM_ADMIN_SOURCES`, which win when set (0020, `placement.rs`).
  `fathom-server console-placement --reset` clears a placement that locked everyone out.
- SMTP is a console setting with a form and no client behind it; every start says so when unset. CSP
  and HSTS headers are on every response.
- **Sessions and Site access (ADR-0057, 0027-0028).** An account session survives a reload and
  expires after 1 hour idle or 12 hours at most. Site access needs the live account session and a
  fresh verification code when the last is over 15 minutes old. An address change ends the Site
  session, not the account session. The check (`FATHOM_SESSION_ADDRESS_CHECK`, default `site`)
  applies per IPv4 address or IPv6 /64.
- **Not built:** sending mail (so no reset or notices by mail); a passkey as the phishing-resistant
  second factor NIST asks for; the console UI for a second operator's own signature on a request that
  needs one; a way for the console to hand a requested colleague their setup token (it is minted and
  discarded; finish from the host with `recover-operator` once their account exists).

---

## The browser client

`client/`: React, Vite, React Flow, plain CSS. Typecheck, tests, build and `gate-npm` are green.
Surfaces are specified in `docs/UI-SPEC.md` and `ADR-0060`/`0061`.

**The look** (#139; UI-SPEC "Look"): Hairline with the Blueprint finish. Square flat buttons with
spaced-capital labels, grouped buttons in one frame, frosted pop-overs, a selection as four corner
ticks, every duration a token and off under reduced motion. The bar folds as the window narrows
(search, then Docs/History/Share/Print into **More ▾**, then lenses and look into **View ▾**); each
breadcrumb does one thing.

**Sign-in and the console**
- **Enrolment and sign-in, both planes.** A token's prefix names its door (`op_` operator, `inv_`
  invitation). Enrolment makes a non-extractable keypair before the request goes out. First run (ADR-0056)
  takes the setup token, address, password, authenticator app and ten recovery codes shown once;
  `SignIn.tsx` is address and password, then the code when asked. A browser key is evidence sent with a
  session, not the only way in. CI redeems the first-operator token (`scripts/ci/first-operator-signin.mjs`).
- **Operator console** (`components/console/`): accounts, invitations, organisation shells and claims,
  operators, console placement and the SMTP setting. The organisation claim signs the genesis grant in the
  browser, shows the recovery key once, then forgets it (ADR-0057). Not on the console: the two-person
  verbs (no assertion by the enrolled key yet), the site trail, an account list.
- **Home** has tabs (ADR-0060 decision 7): Designs, Organisation (admins and folder stewards; a rail of
  People, Waiting for you (N) and Folders), and Admin (the console, only where it answers). Each shows only to someone who may use it.
  The account menu holds Your account, Signed-in browsers, theme and Sign out; an amber "Admin" pill
  shows beside the initials where the console answers. "New design" goes in the first Site the person may
  draw in. Names start as "Untitled design", sealed under the organisation key (`designs.name_*`); Rename
  needs `draw`. **People and access** (client, `components/organisation/`, `api/invitations.ts`,
  `api/people.ts`): invite (name, optional email, Read/Draw/Steward, folder) gives a one-time link and a
  sign-in name that the steward sends; the invited person opens `/invite#inv_...`, gets a key and a
  key-check code to read out; the steward confirms everyone waiting with one signature action (up to 500,
  full list shown first, proposal checked against the rows before signing), steward requests one at a
  time, second-steward approval in the same screen, per-person page with Remove and Give more access.
  Not built: removing access given to the whole organisation (the server's revoke route needs a folder),
  making an existing member a Steward, the contact email after confirmation.
- **About Fathom** (You panel) lists every shipped library and licence; `scripts/licences-npm.mjs` fails
  CI when a package's licence is off `deny.toml`'s list or the list and lockfile disagree (`--write` fixes).
- **What a pasted Junos SRX config now records for the path trace** (ADR-0061 item 9, schema 0.17).
  Each policy set holds its zone pair (`PolicyScope::ZonePair`, zones as node ids), policies keep
  `then permit/deny/reject` and `match` any/names (address objects and sets from the global address
  book, applications by name), and static routes (`next-hop` address, interface unit, `discard`) hang
  off the one unnamed default routing instance. Not recorded: an OPNsense rule's interface and
  direction (a design call), zone-scoped address books, `dns-name`/`range-address`, predefined
  application ports, NAT. The five value types have shapes (`value.rs`); nothing builds NAT.
- **Path trace** (ADR-0061 item 9, schema shapes in 0.17). `fathom-inventory/src/trace.rs` walks cables and
  patch panels, VLANs at switches, a route lookup at each routed device (connected and static, longest
  prefix) and the firewall (zones, then every policy in device order with "matches / doesn't match /
  can't tell" and the reason). It stops at the first thing the design does not state. `OP_TRACE` (36) runs
  in the page; right-click a device, "Trace a path from here", then an address or device and an optional
  "TCP 445". Never a verdict. Not built: interface-to-port ties from a paste (so a pasted device's trace
  stops at "not tied to a port" until the tie is drawn), learned routes, NAT, port right-click, the
  Diagram look, the "Trace from here" offer from "It's down". `scripts/drive-trace.mjs` drives it.
- **Inventory table with pages and shared custom fields** (schema 0.16, ADR-0062). Field definitions are an organisation-wide server store (migration 0035); a value is a `FieldValue` node in the design. Private fields are not built.
- **IP and VLAN tables, file importer** (ADR-0063, importer): Inventory Prefix and VLAN kinds derived from the drawing, and one importer (CSV, NetBox, Proxmox, nmap).
- **Cable corrections from the floor.** Anyone with Read on a design's place sends "Traced ✓", "Label wrong" or "Not here" about a cable (`cable:` and a ULID); someone with Draw accepts or dismisses it. Corrections are their own server store (`cable_corrections`, migration 0036), sealed under the organisation content key, never graph nodes. Text is refused when the redaction gate's bare credential check fires (`enable secret cisco123` form), so ordinary prose with key or secret in it can be refused too. Accepting is the Draw user's ordinary edit as one undoable batch ("accepted <name>'s correction"; a not-here report becomes a note without the name); if the edit or its save fails the client reopens the correction (`POST .../reopen`, accepted only). Dismissing re-seals the body as empty text, so what was typed is not kept; a dismissed one cannot be reopened. The database binds sender and decider to the session account. A Read sender sees only their own; caps of 5 open per sender per cable, 20 per sender and 200 per design. Orphaned corrections (cable removed) list on the Corrections waiting page with Dismiss only. Known limits: no chain entry for a correction or decision (L2), no retention clean-up of decided rows.

**The canvas** (one canvas, detail by degrees; ADR-0060)
- **Racks and devices.** Opening a design reads the plain face (ADR-0049) and draws racks with rails,
  U numbers, hatched free runs, device boxes and ports that fade in toward the faceplate. Four camera
  stops: closet 87.5%, rack 100%, faceplate 200%, inside 300%. Ctrl+wheel or pinch zooms (max 400%), the
  wheel pans. Placing snaps to a unit and refuses an overlap with a shake. Every change saves: one in
  flight, the latest queued, a refusal shown and never rolled back. A rack's height is 42U, 24U, 12U or
  typed, refused below what is mounted.
- **Rear elevation** (ADR-0050): every rack has front and rear; supplies are parts in slots with their own
  serials; *single-fed* and *one fitted* are derived. Racks have a row and bay.
- **Shelves, surfaces, sketches** (ADR-0051): shelves take units and slots; devices fix to a wall, floor,
  desk, ceiling or board. A device with no model carries ports typed by hand and says so. Outlet boxes and
  panels get pass-through pairs and a lit path.
- **Cables.** Bundles fan open on hover; a hovered or selected cable lights its whole path; a cable leaving
  the closet ends in a dashed portal tray. PSU inlets on the rail. Ports sit at catalogue row and column;
  cables leave a port's own edge. At 200%+ a bundle splits with port labels.
- **Free boxes, lines, areas** (ADR-0060 step 7, schema 0.13). Small ink circles on a selected free box
  draw a line or add a dashed box. Marquee select, copy, paste, duplicate, alignment guides, arrow-key
  nudge, an Align / Spread / Group / Label menu, labels and areas that carry what sits inside. Shelf grips
  set height and slots. Not built: line routing, a highlighted drop unit, touch marquee.
- **Look switch** (ADR-0061): Rack (faceplates, dressed cables) or Diagram (plain labelled boxes, square
  lines in sheath colour, view-and-select). Kept per browser, account and design (`drawing/look.ts`). A
  cable whose far end is off screen draws as stubs ending in a tag that pans to it (`drawing/stubs.ts`).
- **Equipment list** (left "Equipment" button): search, headings Common / On a wall / Exact models; click
  or Enter adds where there is room. Common devices arrive named (router-1) with a role.
- **Right-click menus:** device (Details, Duplicate, Remove, Open, Inside, Paste config), rack (Details,
  Add a device), cable (Details, Disconnect), empty canvas (42U, 24U, 12U rack, wall). A reader gets Details.
- **Open a device, paste a config anywhere** (ADR-0060 step 8). Right-click Open or double-click enters
  "jot mode" (`components/jot/`): the device large with its ports, equipment dragged in, cables dragged
  port to port, Config and Inside buttons, Esc out. Ctrl+V or Paste config runs text through the wasm gate
  (`components/paste/`) and shows a card: hostname, platform, interfaces, what the gate destroyed by kind
  (never values), attach to the same-named device or add a new one. Nothing is stored until you choose.
  Not built: replacing a device's capture; a cable to a free box on the full canvas.
- **Config drawer and inside stop** (ADR-0052): the gate runs in the browser; a driven run proves seven
  device-length credentials absent from every save body. The drawer shows the six rules, a black block
  where a value was destroyed and a lit port per built line. Readers see text only. Inside shows a
  firewall's zones, interfaces, policy rail, routes and tunnels, never a verdict.

**Inventory, notes, undo** (ADR-0053, 0058, 0059)
- Two places over one document: Canvas and Inventory. Inventory has a rail of kinds, a device grid
  grouped per rack, the Gaps section, one page as the editor, and Show on rack. Networks kind: VLANs,
  subnets, Docker networks with containers and published ports.
- **Notes** are nodes on a device, port or rack: pasted through the gate or stored as typed, and saying so.
- **Undo** is a new batch of reversing operations; only your own batches, and a colleague's later change
  refuses by name. The trail shows sealed and pending, with a comment on the next change.
- **Tags** (schema 0.12): chips on devices, ports, cables, racks, premises, VLANs, Docker networks,
  containers; "Add tag" suggests existing ones; quick search finds by tag; tags are a Cables list group.
  Inventory has a Tags column and chip filter; typing `tag:edge` (or `Model:x`) in + Filter picks the column.

**Saves, designs, scopes** (ADR-0054). A save names its base version; a stale base is refused naming both
numbers and nothing is written (the wash offers Reload). Draw can create a design, a steward of the parent
a scope. The server refuses credential-looking capture, note or doc text, re-checks the grant inside the
acting transaction, and caps a body at 1 MiB until the signature is checked.

**Checks** (ADR-0061 §5-6, #97, #103). The Rust engine runs in the browser (wasm) and checks the open
design against twelve written rules (`corpus/rules/`: addresses on a link, VLAN access and trunk,
cable media, link speed, one cable per port, single-fed power, single-cabled switches).
- A bar chip counts findings and opens a docked, draggable panel; severity is a word and a glyph, never a
  colour. Each finding has a **Why?** card: the plain reason, the fix, when it is acceptable, and a source
  note. A wrong drop is refused with a card naming the rule. Badges show for refuse and warn only.
- Checks load incrementally: about 19 ms per edit at 1000 devices against about 4.5 s reloading whole.
- Every rule's reviewer is `pending: Key Maker`, so Why? says "Source not yet checked by a person".
- The server runs no checks.

**Docs** (ADR-0061 round 7, #109, schema 0.14). A doc has a title, Markdown text and links, and is about a
device, port, cable, rack, catalogue model (shows on every unit) or the design. A "Docs" line in those
panels and a Docs button in the bar open the list. Markdown is a safe subset (no HTML, images as words,
http/https links with host). Pasted text goes through the gate; typed text is stored as typed; the server
refuses a credential in doc text. Files (PDF, image, text, 25 MB) hang off a doc: text is gated in the
browser and only the redacted copy uploaded; the server sniffs by content, refuses text still carrying a
password, seals bytes under the design key and serves downloads only. Images and PDFs (no PDF text
check yet) need a per-file confirm ("Add, it shows no passwords") and show "Not checked · image/PDF".
"Remove" takes a file off the doc (undoable); "Delete for good" (Draw) erases the sealed bytes, keeps
name, size and hash in the history, and fetch answers 410 (migration 0033). Not built: a Docs Inventory
kind, docs on maintenance plans.

**"It's down"** (ADR-0061, troubleshooting; schema 0.18, field keys 390-404): right-click a device, or the button on its page,
opens a side panel with the device's chain as a checklist (power, neighbours, link, port, address, gateway)
answered OK / Not OK / Can't tell, with Why? cards, an optional typed note, where the answers point and Also
affected. Plan a fix makes and opens a plan; Save as an issue puts it in the device's history and the
Inventory's Issues list (an Issue page per record). A read holder sees saved issues only; the server refuses
a credential in issue text. Logic: `components/troubleshoot/`, `document/issues.ts`,
`drawing/troubleMarks.ts`. Checked by `scripts/drive-troubleshoot.mjs`.

**Firmware** (ADR-0045, ADR-0064; schema 0.19, field keys 405-411; migration 0038). Inventory › Firmware
lists staged images (version, models, SHA-256, running, behind, plans) with upload; Inventory › Models sets
a model's chosen version and holds devices back with a reason. Check `fw.device.behind-chosen-version`
flags a device behind its model's version. "Plan a firmware upgrade" (right-click, device page, or for every
behind device) makes a maintenance plan with the vendor's steps for Junos, IOS XE, NX-OS or EOS; the
device fetches its image with a one-time link. On in compose once `FATHOM_FIRMWARE_FETCH_BASE_URL` is set.

**View sharing** (ADR-0061 round 9, #102). A steward's **Share** button in the bar opens a panel with
PERSON / CAN rows: **View** (see everything, change nothing) or **Draw**. Only people already in the
organisation can be added. The grant is signed in the steward's enrolled browser and the server
re-derives every signed field. Shares do not expire and cover everything inside the scope. Not built:
outside invites, a public link.

**Print pack** (#39, round 10). Print lists pages with counts: This view (also a PNG drawn by the browser
from the canvas), Rack elevations, Cable schedule, Port map; "Make PDF" opens the preview and the browser's
own Save as PDF. A4 or Letter; cables none, all or as shown on screen; serials and management addresses
optional; black and white with colours as words; title block and page x of y. Port map also as .csv or
.xlsx. From Inventory the pack also prints the table as shown (its columns, filters and sort).

**Cables list** (#54). From the lit Cables lens: groups by VLAN, tag, type or device, a count each; a ticked
VLAN's trunks draw dashed; "Hide this cable" with a "n hidden · show" chip. Per browser and design, never
saved; both looks. Quick search also finds cables, VLANs and containers by name or tag.

**Show menu** (#110, #121, #123). Layers on the drawing: Checks (on by default), Addresses, VLANs, Docs,
Maintenance, Tags. Device style for the Diagram look: Boxes or Icons (outline router, switch, firewall,
server, access point). Per browser and design, never saved.

**Maintenance plans** (#98; schema 0.15). A plan is ordered typed steps. Plan (indigo, dashed, What it
touches with Why? cards via `OP_PLAN_PREVIEW`), Do (teal checklist, one live step, Done or Went
differently), Record (outcome, never edited again). Right-click "Plan a change". Steps apply through the
ordinary edit path; plan text is gated like notes.

**Live co-editing** (#98, ADR-0063 live). Changes are signed requests the server applies to its own
head through the engine, refusing what the engine or the credential check refuses, then numbers, chains,
encrypts and streams them to other browsers. Different fields merge; on the same field the later one
wins, and the overwritten person can **Put mine back**. Others show as initials dots in the bar.

**History panel** (#124, #128). The bar's **History** leads with the chain check in words ("Checked:
every save is intact", "Broken at save N"), lists saves newest first, shows any save read-only with its
changes outlined, and **Restore this version** (Draw) makes a new save.

**Open, not on main yet:** #136 port ties, #137 reconnecting, #138 History speed. #141 (ticked ideas:
Ctrl+K, Undo note, saved views, folding panels, faceplate port dragging, pinned notes) merged into the
UI sweep branch after that branch had merged, so it is not on main.

**Carried**
- The dependency-vulnerability gate needs egress to the advisory database (`scripts/osv-gate.sh`); the
  v0.1 tag waits on that run.
- The server's credential check is the detector only; SNMPv3 auth and priv values are a known residual
  (W7). Narrow redaction leaks are tracked in issue #104; #135 closed its server items (id-shaped
  secrets in plan text, batch comments, history under undeclared keys, canvas-editor paste), and its
  quoting and wrapped-tail items remain.
- People and access, residuals named: (1) an operator-issued token for an account can still be redeemed
  after a steward confirms that account (design section 4.4), so a second key could appear after confirm;
  (2) confirm checks that the account has exactly one live key, and nothing about a password or app
  code, which only the joiner can set today (revisit once a mail path exists); (3) the daily cap of 50
  invitations is per steward per organisation, not across organisations.
- Nothing exercises two genuinely concurrent saves (the row lock serialises them).
- Trail and notes: the sealed mark is an idle-time approximation; the comment box should attach to the
  next batch; a note's line count is taken before the gate; private notes arrive with the vault (W6).
- Wire shapes have no cross-language vector yet.
- Unbuilt: saved filters and grids for racks, cables and ports; unreachable-policy hatching; the
  assistant panel; optics (ADR-0047 §5); a Proxmox dictionary.
- Rough edges: the drawer tags every built line; no confirmation pulse after a paste; the opened
  occupant can sit under the editor.
- The old Rust-assembled HTML client is retired, on disk under `crates/fathom-artifact/`, not served.

---

## Never built

Walkthrough view (the teaching half of the product); Config view; the building and room stops
(decided: UI-SPEC "The building", ADR-0051); engine manager (how equipment types are registered and
kept current); automatic correlation across separately-pasted configs; anything that discovers a
network live (everything today comes from pasted text).

---

## Known limits worth remembering

**Compose, run end to end by CI.** `docker compose up -d` from the root with one variable in `.env`
(`docs/RUNNING-IT.md`) pulls the image `publish.yml` pushes to GHCR on every merge to `main`
(`deploy/Dockerfile`'s `server` stage, `ghcr.io/keyxmakerx/fathom-server`); `--build` builds the same
stage. The file is self-contained. A one-shot `keys-init` container generates the two root keys and
three database passwords into the `keys` volume. CI's `compose` job checks health and the client on
the published port, reads the first-operator token, and proves a restart keeps its keys.

**The server serves the web client itself** (`crates/fathom-server/src/client.rs`,
`FATHOM_CLIENT_ROOT`, read into memory once at startup) on the one published port, plain HTTP. HTTPS is
the operator's reverse proxy's job; the browser's WebCrypto needs it for sign-in. The operator
console can be confined to host names and source ranges (`FATHOM_ADMIN_HOSTS`,
`FATHOM_ADMIN_SOURCES`); elsewhere its paths are 404.

**A client's address is one rule for every route** (`client_address.rs`). `X-Forwarded-For` is
believed only from `FATHOM_TRUSTED_PROXIES`, across every line of the header: the client is the last
entry the trusted proxy appended, or the `FATHOM_FORWARDED_HOPS`-th from the right behind a further
hop. Nothing is trusted by default (the peer is the address and the server warns). A header named
with no proxy trusted refuses to start.

**The test suite needs a fresh database.** Tests against one database share global state: triggers,
rate-limit buckets, the site chain, settings rows (`docs/NEXT.md` rule 3 has the isolation
requirements). Reused, the suite fails intermittently.
- `past_the_bound_a_rotation_is_refused_and_drains_to_succeed` fails only on a reused database. Not
  fixed; it costs nothing under rule 3, and CI creates a database per run.
- `tests/operators.rs` leaves a `fathom_isolated_*` database behind per test. Harmless in CI; a slow
  leak elsewhere. Not fixed; the fixture is the place.

**The server refuses to start on a broken schema, deliberately.** `EngineState::load` runs every gate;
a failure is a startup failure naming the gate and file, exit 7. `deploy/Dockerfile` copies `schema/`
into the distroless runtime stage from the build stage. `FATHOM_SCHEMA_ROOT` overrides the path.

- **Typed values are not redacted.** The gate runs on paste only. A password typed by hand is stored
  and exported as written, with a warning mark. That is the decision, not a bug.
- **Nothing creates cables or ports from a config.** Only by hand.
- **Engines are files in the tree.** ADR-0044 describes signed data packs; none of its Phase 5
  exists (no `engine.yaml`, signature, install, chain entry or pinning). The server reads
  `corpus/catalogue/` from disk at start; the client compiles `corpus/dict/` into its bundle. Every
  device fact is cited with its read date; every credential test uses the length the device accepts.
  - **Juniper.** `junos-srx` is the one dictionary with real depth (a branch config binds about 57% of
    its lines). `junos-ex` binds VLANs, ethernet-switching membership, LAG membership and irb units;
    `interface-mode` is unbound on purpose. A virtual chassis has no schema representation. The
    catalogue covers the EX4300, EX2300, EX4100, SRX300 and SRX340 (1U; the vendor page wins over the
    design board).
  - **OPNsense.** The rules-migration CSV (26.1 and later) is the only readable export and the only one
    bound. Aliases export as JSON. `config.xml` needs an XML framer; the fields it must destroy are in
    `corpus/dict/opnsense/README-config-xml.md`. The dictionary declares no secrets and the core floor
    destroyed every credential driven at it. No catalogue entry: the catalogue has no form for "a box
    that runs OPNsense".
  - **Ubiquiti.** Catalogue: UDM-SE and two USW PoE switches. UniFi has no human-readable export, so no
    dictionary. EdgeOS binds hostname, interface description, disable and `vif` sub-interfaces; base
    addresses, static routes, DHCP server and NAT are unbound (`corpus/dict/README-ubiquiti.md`).
  - **Linux hosts.** A zero-entry dictionary: `ip` and `bridge` output is not verb-initial and
    `shape.rs` shapes only `set` lines (`corpus/dict/README-linux-host.md`). A pasted WireGuard private
    key is still destroyed. Eight per-flavour explainers plus `linux-family-basics`, cited.
  - **Arista.** Two catalogue entries (720XP-48ZC2, 7050SX3-48YC8) and an EOS explainer; no dictionary
    (same shape gap). The safety net destroys every credential in a 120-line synthetic config
    (`crates/fathom-ingest/tests/arista_eos.rs`).
  - Every explainer carries `reviewed_by: <named human>`, which means unreviewed; no client surface
    shows that yet (OPEN-QUESTIONS E2 is answered, not built).
  - **Engine gaps:** ADR-0044 rule 2's redaction-unproven refusal is not built; the
    core floor is the only fence. A credential typed into the free-text description cell of the
    OPNsense CSV is not caught (pinned in `opnsense_csv.rs`). The `<named human>` placeholder is a
    warning, not a build failure, because the shipping gate does not exist. A dictionary cannot bind
    `lacp_mode`, an interface form or a `NextHop` (`ValueTy` has no arm). The catalogue has no plain
    SFP or SFP28 kind. `secret_exempt` is honoured only for path shapes a core-held allowlist names;
    empty citations and reviewers are refused; every dictionary file carries a `source` header and a
    reviewer.
