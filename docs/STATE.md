# What is actually built

**Last confirmed:** 2026-10-02: 1561 Rust tests and 1531 client tests on commit 3b10bfc, read off the runs. Read numbers off a real run, not off this page.

This page records what exists. It is not a changelog — history lives in `docs/archive/`.

---

## Working and keeping

**The Rust engine.** Schema toolchain, typed graph store, config ingest with the redaction gate, the
fragment-to-store weld, the finder, emitters, layout. Zero external dependencies on the client side,
deliberately. The schema is real and enforced; read counts off `fathom-schema-check`.

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

Built at `client/` in React, Vite and React Flow. Typecheck, tests, build and `gate-npm` are green.

- **Sign-in and enrolment, both planes, no choice of plane.** Enrolment redeems a token and generates
  a non-extractable keypair stored under a pending slot before the request goes out, promoted on a
  confirmed answer. The operator plane has its own door (`/enrolment/operator`, whose answer carries
  the operator id). A token's prefix names its door (`op_` on the server's file, `inv_` on the
  console's invitations; `operators::BOOTSTRAP_TOKEN_PREFIX`); sign-in lists identities this browser
  holds a key for, or looks a typed one up on both planes. The first operator is named after the
  notice address. CI's compose job redeems the first-operator token
  (`scripts/ci/first-operator-signin.mjs`).
- **First run and sign-in (ADR-0055 decision 10, ADR-0056).** No operator door is a key-only
  redemption. Until the first operator has a password (`GET /setup/state`) the client shows the
  first-run flow: setup token, the address, a password, the authenticator app (QR code and setup key),
  ten recovery codes shown once. `SignIn.tsx` is address and password, then the verification code when
  asked, for any account; a browser key is evidence sent with a session, not the only way in.
- **The operator console** (`client/src/components/console/`): create an account and invitation,
  reissue one, disable or re-enable an account, create an organisation shell and claim, list operators
  and organisations; every token shown once. `PlacementForm.tsx` sets the console's host and sources
  (warns, redirects, confirms or reverts in a window); `SmtpForm.tsx` writes the `smtp` setting and
  asks for a test send; `Operators.tsx` adds and disables operators with the one-operator warning. The
  organisation claim redeems with `POST /enrolment/organisation`: the browser makes the root keypair,
  signs the genesis grant, shows the recovery key once as base32, then forgets it; the server verifies
  the signature before writing (ADR-0057 decision 5, 0027). Not on the console: the two-person verbs
  (they need an assertion by the enrolled key this client does not build), the site trail, an account
  list (no route).
- **The shell of ADR-0047:** the one-row bar, the path that opens the scope tree, the five lenses,
  search that collapses to its magnifier, presence, undo and redo, zoom, the
  account menu, an editor absent when nothing is selected. **Home** lists your organisations and the
  designs you may open under their closet's name; an account with one place goes there directly.
- **The Canvas** (Session 4). Opening a design fetches the catalogue and payload, reads the plain face
  (ADR-0049) into the browser's document, and draws it with React Flow: racks with rails, U numbers,
  hatched free runs, device boxes, and ports fading in toward the faceplate stop. The camera has seven
  stops (UI-SPEC "The shape"); the client has four: closet 87.5%, rack 100% (one 42U rack fits),
  faceplate 200%, inside 300%. A dragged palette item snaps to a unit, refuses an overlap with a
  shake, and places the device, chassis and ports. A device can be removed with everything it contains.
  Every change saves: one save in flight, the latest queued, a refusal shown and never rolled back. The
  TypeScript writer reproduces all three Rust-made vectors byte for byte; the server reads every
  payload back before storing it.
- **Cables** (Session 5). Drawn as UI-SPEC "Cables" says. Bundles with a count fan open on hover; a
  hovered or selected cable lights its whole path through panels and portals; a cable leaving the
  closet ends in a dashed portal tray. PSU inlets on the rail (filled when fed, the single-fed wash, a
  PDU's n of m used); a front | rear flip at the rack stop. The editor edits hostname, role,
  management address and serial; typed values are marked and a refused value is said aloud. A cable's
  panel has colour selector and ends; ports offer Select cable and Go to far end; a cables view control
  filters by kind; a wrong drop shakes the port. Catalogue: an APC PDU and two Panduit panels, cited.
- **The rear elevation** (Session 6, ADR-0050, schema 0.7). A rack has a row and bay; a supply is a
  part in a slot with its own serial, hosting its inlet port. The catalogue records each supply slot
  per face with a hot-swap flag, and management and console ports by name (the EX4300's me0, con and
  both slots, cited). Every rack has two elevations; the closet stop lays racks out by row and a row
  flips as one camera. *Single-fed* and *one fitted* are derived. The editor fits or removes a supply
  and sets a rack's row and bay.
- **Shelves, surfaces and sketches** (Session 6(b), ADR-0051 §1-2, schema 0.8). A shelf takes units
  and its occupants take slots. A device or passive is fixed to a wall, floor, desk, ceiling or a board
  on a wall; equipment outside a rack draws whole. A device with no catalogue entry carries ports typed
  by hand and says so. A port records its face. An outlet box or panel gets pass-through pairs at
  placement and a lit path follows them. Catalogue: a Tripp Lite shelf, an ICC outlet box and a
  CyberPower UPS, cited.
- **The config drawer (view-only) and the inside stop** (Session 6(c), ADR-0052, schema 0.9). The
  redaction module ships as a file and runs in the browser with no packages; a paste goes through the
  gate before anything reaches the document, and a driven browser run proves seven credentials of real
  device length absent from every save body. The drawer sits under the dimmed faceplate with the three
  gutter marks, a black block where a value was destroyed, the six rules printed, and a lit port for a
  built line. The capture is a node on the device; marks derive from provenance on reopen. A reader
  sees a view-only chip and text only, and the server refuses a read account's save. The inside stop
  draws a firewall's zones, interfaces, policy rail, routes and tunnels, never a verdict.
- **Inventory, notes, undo that records** (Session 6(d), ADR-0053, schema 0.11). Two places over one
  opened design, sharing the document and save queue. Inventory has a rail of kinds, the device grid
  grouped per rack with the lens choosing columns, the Gaps section, the page as the one editor, and
  Show on rack both ways. The Networks kind (ADR-0058): VLANs, subnets, Docker networks with their
  containers and published ports, and an editor. A note is a node on a device, port or rack, pasted
  through the gate by its own door or stored as typed and saying so. An undo is a new batch of
  reversing operations (a revive operation restores what a tombstone removed); only your own batches,
  and a colleague's later change refuses by name. The trail beside the drawing shows sealed and
  pending, a comment on the next change, live chips and keys.
- **Saves, designs, scopes** (Session 7, ADR-0054). A save names its base version; the server refuses
  a base that is not current, naming both numbers, and writes nothing; the wash offers Reload.
  `POST .../scopes/{scope}/designs` (draw creates a design) and `POST .../scopes` (a steward of the
  parent creates a scope) make a design reachable from a fresh deployment. The server refuses a
  payload whose capture or note text still looks like a credential; save, open, verify and create
  re-check the grant inside the acting transaction; a body is capped at one mebibyte until the
  signature is checked.
- **Print, phase 1** (#39). A Print button beside Undo, or Ctrl+P: this rack, every rack in the
  closet, or the cut sheet; A4 or Letter; cables none or all; serial numbers and management addresses
  optional; black and white with cable colours as words; a title block and page x of y on every page.
  A rack sheet draws front and rear to scale with a device table. The cut sheet has a block per device
  and a row per port, as .csv or .xlsx. Not built: the map sheet and "as filtered on screen".
- **Tags** (ADR-0059, schema 0.12). A tag is a node that a device, passive, port, cable, rack,
  premises, VLAN, Docker network or container points at. Chips sit in those editors and on VLAN rows,
  Docker networks and containers; "Add tag" suggests existing tags; clicking a chip's name renames the
  tag; a VLAN row tags through its members ("2 of 3"). Quick search finds devices, racks and ports by
  tag. Not built: the Inventory column and filter, tags in the cable filter (#54), search over cables,
  VLANs and containers.
- **About page and licences** (ADR-0060 decision 12). "About Fathom" in the home screen's You panel
  lists every library the web app ships with licence and copyright. The canvas no longer shows React
  Flow's corner link. `scripts/licences-npm.mjs` fails CI when a client package's licence is off
  deny.toml's list (build tools may also be MPL-2.0) or the About list and lockfile disagree; `--write`
  regenerates the list.
- **Rack height and surface placement** (ADR-0060 decisions 5 and 11). A rack's details panel offers
  42U, 24U and 12U or a typed height, and refuses one below anything mounted in it, naming it. Moving a
  device onto a wall, floor, desk or board no longer asks for millimetres; the surface lays it out.
  Dragging onto a surface comes with free boxes on the canvas (step 7).
- **New design without a Site** (ADR-0060 decision 6). The home screen's "New design" puts the design
  in the first Site the person may draw in, else a Building or Closet they may draw in, else a new Site
  named after the organisation. Design names are not built.
- **Plainer canvas words** (ADR-0060 decisions 1 and 4): the Racks place is called Canvas; the left
  strip is one "Equipment" button that opens the equipment list; built-in items read "Any device" and
  "Backboard"; "+ add a surface" reads "+ Add a wall, floor or desk"; an empty design shows a note
  saying what to do; the zoom, account and trail controls name themselves on hover.
- **The equipment list** (ADR-0060 decision 4) has a search box and headings: Common (Router,
  Switch, Firewall, Server, Access point, Any device), On a wall (Backboard), Exact models. Clicking a
  row, or Enter on it, adds it where there is room, the selected rack first and from the top down. A
  common device arrives named (router-1) with its role set, dragged or clicked. Clicking Backboard
  puts one on the first wall, floor or desk.
- **Right-click menus** (ADR-0060 decision 4) replace the browser's on the canvas:
  - A device offers Details, Duplicate and Remove.
  - A rack offers Details and Add a device.
  - A cable offers Details and Disconnect.
  - The empty canvas offers a 42U, 24U or 12U rack and a wall, named Rack 2, Wall 1 and so on.
  - A reader gets Details only.
  - Adding a wall, floor or desk no longer waits for a rack; the design's premises is made
    alongside it.
- **Home tabs and the account menu** (ADR-0060 decision 7):
  - Home has tabs: Designs, Organisation and Admin. Each shows only to someone who may use it,
    and the row is hidden when Designs is the only tab.
  - Organisation is for the organisation's admins. `GET /organisations` now carries the caller's
    own role, `admin` or `member`, to decide this; the server still authorises every act. The tab
    holds the folders (Sites, Buildings and Closets) and where to make more. Designs no longer
    offers New site, New building or New closet.
  - Admin is the operator console, renamed from Site. It is a Home tab where the console
    answers; choosing it signs in to the console, and asks for a verification code there when
    one is needed. The console shows the same tabs above it.
  - The account menu holds only the person's own things: Your account, Signed-in browsers (the
    same screen, opened at that section), the theme, and Sign out.
  - Not built yet: people, invitations and roles on the Organisation tab, which need server
    routes, and the one-form "Create an organisation for myself", which needs a security review.

**Carried:**
- The dependency-vulnerability gate needs a machine with egress to the advisory database
  (`scripts/osv-gate.sh`); the v0.1 tag waits on that run.
- The server's credential check is the detector only; SNMPv3 auth and priv values are a known
  residual until dictionary matching runs on the server (W7).
- Nothing exercises two genuinely concurrent saves (the row lock serialises them by construction);
  the "two people on a running server" proof is still stood in for by tests and screenshots.
- Trail and notes: the sealed mark is an idle-time approximation until the session hook exposes save
  completion; the comment box should attach to the next batch, not an already-recorded one; a note's
  line count is taken before the gate; the private notes layer arrives with the vault (W6).
- Wire shapes have no cross-language vector yet.
- Unbuilt: saved filters and the grids for racks, cables and ports; replacing a capture (a second
  paste into the same device is refused); unreachable-policy hatching; the assistant panel; optics
  (ADR-0047 §5); a Proxmox dictionary with guest and bridge kinds.
- Rough edges: the drawer tags every built line and should show them on hover only; a successful
  paste has no confirmation pulse; dropping a board onto a surface is a no-op until the drawing has a
  surface drop zone; the opened occupant can sit under the editor; a panel's label pairing remains as
  the fallback when no pass-through edge exists.
- The left-right order of the EX4300's two supply slots could not be established.
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
  - **Engine gaps:** the client boots one dictionary beside OPNsense (`shell.rs` holds a single slot),
    so `junos-ex` and `edgeos` are compiled in but not booted (`engine.ts` lists them as excluded; a
    test refuses a silent omission). ADR-0044 rule 2's redaction-unproven refusal is not built; the
    core floor is the only fence. A credential typed into the free-text description cell of the
    OPNsense CSV is not caught (pinned in `opnsense_csv.rs`). The `<named human>` placeholder is a
    warning, not a build failure, because the shipping gate does not exist. A dictionary cannot bind
    `lacp_mode`, an interface form or a `NextHop` (`ValueTy` has no arm). The catalogue has no plain
    SFP or SFP28 kind. `secret_exempt` is honoured only for path shapes a core-held allowlist names;
    empty citations and reviewers are refused; every dictionary file carries a `source` header and a
    reviewer.

---

## Reference

`/home/user/pouzor/homelable` — a smaller, well-built homelab visualization tool used as a reference
for the client rebuild. React; it solves several problems we hand-built.
