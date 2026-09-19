# What is actually built

**Last confirmed:** 2026-09-19: 1311 server-side tests and 834 client tests, read off the runs. Read numbers off a real run, not off this page.

This page records what exists. It is not a changelog — history lives in `docs/archive/`.

---

## Working and keeping

**The Rust engine.** Schema toolchain, typed graph store, config ingest with the redaction gate,
the fragment-to-store weld, the finder, emitters, layout. 1208 tests passing as of 2026-09-14. Zero external
dependencies on the client side, deliberately.

**The schema.** Real and enforced — roughly 51 kinds, 95 edges, 61 scalars at version 0.5. Read
the actual numbers off `fathom-schema-check`; this line has been wrong before.

**The server.** `crates/fathom-server` starts, answers a health check through a real PostgreSQL,
shuts down cleanly, and runs behind TLS in a composed stack. It stores identity and structure —
accounts, organisations, memberships and the organisation → network → building → rack tree — and,
as of migration 0007, **encrypted designs**. As of migration 0009, the server also maintains
encrypted audit chains at the site and organisation levels, and a spool that ships sealed entries
for external custody.

**Migration 0006 separates migration and runtime roles.** The migration role owns the schema and
runs migrations with `CREATEROLE`; the runtime role (`fathom_app`) has data privileges only — no
ownership, no DDL, no `CREATEROLE` — and serves every application request. The server refuses to
start if its role is a superuser or bypasses row-level security (decided 2026-09-12, §15.0 of
`docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md`).

**Encrypted design storage, as of 2026-09-12.** A master key from a file (or `command://`, or
`env://` — ADR-0043 §3) wraps a random per-tenant key, which wraps a random per-design key, which
encrypts the payload whole with ChaCha20-Poly1305 and a fresh random 96-bit nonce. Per-design keys
are **mandatory rather than preferred**: the birthday bound on a random nonce is the entire safety
margin, and one key per design is what makes it irrelevant. The master key's non-secret id is
stamped into the database, so restoring beside the wrong key file reports *"this database was
encrypted under master key a41f…, the configured key is 9c02…"* instead of an AEAD failure that
reads like corruption. Every version appends an HMAC-SHA-256 sealed chain entry binding both the
plaintext and the stored bytes; verification reports **verified**, **broken at entry N**, or
**cannot verify under key epoch K**, and a links-only run says *content not re-bound* rather than
anything that could be read as "content verified". Rotation re-encrypts and writes `reencrypt`
entries; re-wrap is deliberately **not** implemented yet, because §12.6 requires it to write a
sealed entry on a tenant-level chain that does not exist.

**Migration 0008 closed four fences 0007 claimed and did not have**, all found by an adversarial
review on 2026-09-12 and each reproduced. Verification now checks everything checkable **first** and
reports a coverage gap alongside the result rather than instead of it — one `UPDATE` of an entry's
`chain_key_epoch` used to turn a detected forgery into *"a coverage gap, not a failure"* (§12.6a).
The storage pass is entry-driven and checks both directions, so a version destroyed and its entry
re-pointed no longer verifies, and a payload row no entry names is a break rather than a skip. A
design carrying a sealed history, a stored version or a key **cannot be deleted at all** — by the
runtime role, the table owner or a superuser — where one `DELETE FROM designs` used to cascade the
whole history away. The chain master now carries the same stamped key id the master key does, so a
lost chain key reports the wrong key instead of reporting every history as forged.

**Migration 0009 adds chains at three levels:** site (cluster-wide audit), organisation (tenant
audit), and design (edit history, already in 0007). The `chains` module appends to them, reads them
back, and verifies them — every seal, binding and ordering rule decided in `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §7.
The `audit` module (first cut, §9) ships sealed entries as RFC 5424 syslog over TCP to an operator-configured
destination, spooling in PostgreSQL when that destination is unavailable. The append-only fence on the
audit trail is enforced by trigger, not by policy, and binds even a superuser (proved as one by
`tests/append_only_fence.rs`). The `keys` module now holds **organisation content keys**, wrapped under
the tenant key in the same shape as design keys; they encrypt the metadata of organisation-chain
entries. Organisation names and scope paths are still plaintext — storage §11.3's name encryption is
not built.

**Migration 0010 and the checker round of 2026-09-12.** A checker attacking 0009 found the re-wrap
retiring the deployment-wide master key while re-wrapping one tenant, an entry-type constraint that
0009's header promised and never created, an unbounded spool, and the seal and associated-data
constructions pinned by no test. All fixed: the re-wrap is deployment-wide in one transaction with
a `rewrap` entry on the site chain and on every organisation chain; 0010 adds
`chain_entries_type_belongs_to_kind`, and an unparseable type reads as *broken at* rather than as
an error; the spool is bounded per admin §9 and past the bound design writes stop while reads
continue; `tests/chain_vectors.rs` holds golden values produced by an independent Python assembly
of the §11.2 messages (`tests/vectors/gen_chain_vectors.py`), so the two must agree.

**Migration 0011 is the authority layer** of admin design §3 (2026-09-12): organisation root-key
identity, account signing keys, scope grants with signature columns, seconding, suspension and
revocation as their own append-only tables, and the authority head. Every principal reference is a
composite `(id, kind)` foreign key, so an operator cannot appear in an authority row. `authority.rs`
holds the signed-byte constructions and `grants.rs` the acts; ES256 with software keys, verified at
every use, nothing cached. `p256` and `ecdsa` entered through the gate with their records under
`deps/decisions/`. Genesis is real; Shamir shares, WebAuthn, sessions, the admin surface and groups
are not built, and admin §3.2 lists the eleven places the build departed from the design text.
Golden vectors: `tests/authority_vectors.rs` from `tests/vectors/gen_authority_vectors.py`.

**Migration 0012 (2026-09-13)** fixes the second checker round on that layer, admin §3.8: the
head's digest covers the whole authority state and every seconding is verified at use; the
vacuous genesis trigger is gone and the chain names the genesis grants; account keys are sealed
under a site-scoped key; granting is propose-then-sign; suspension cannot manufacture a sole
steward; expiry is evaluated at use; key retirement is a signed act. 0012 refuses to apply over a
pre-release database with enrolled keys — recreate it. A third round (same day, no migration) put
the sole-steward flag inside the signed grant bytes (`fathom/grant/v2`) and made quorum turn on
one qualifying seconding with no depth limit; a fourth checker pass found nothing.

**Migration 0013 is sessions and the first HTTP surface** (admin §4; 2026-09-13): session rows with
a MAC under the site-scoped row key, a browser-held session key, single-use nonces, a signed
message on every request that reaches design payload or vault ciphertext, sign-in by proof of an
enrolled account key with no password path, and routes for challenge, sign-in, sign-out and one
protected demonstration route (`sessions.rs`, `api.rs`). Every gate passed on a fresh database;
this layer was attacked by an opus checker on 2026-09-13. The builder's decisions where §4 was
silent (rate limiting, lockout, token shape) have been read into `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md`.

**Next session starts here** (the full plan is `docs/NEXT.md`): (1) a checker round on 0013, `sessions.rs` and `api.rs`, with the
same posture as the four rounds on the authority layer; (2) read the builder's silent-spot
decisions out of the code into admin §4 and §13; (3) then the rest of §15.6 in order — the admin
surface and the execution interlock, receipts and witness, break-glass — and, in parallel when
the client work begins, the vault (storage §13, primitive decided) and the group tables (admin
§3.7, to be designed and attacked before building). Costs to keep in view: a checker round on a
layer this size has run 250–350k helper tokens, a build 400–550k.

**The server can read design data, and says so** (`docs/PHASE-2-STORAGE-DESIGN.md` §2a).
Encryption protects the database, the backups and the disk — not the running process.

`tests/no_key_protected_data.rs` changed shape with this and is now the stronger gate: every table
declares whether it holds key-protected material and under which key, and a marker written through
the real write path must appear in **no column of any table** — with a positive control proving the
sweep can find a value that is deliberately in the clear. The credential vault is still not built.

**Tenant isolation holds at two layers**, and both were attacked before being trusted. An
application filter in every repository function, and PostgreSQL row-level security driven by a
transaction-local setting — never a session-level one, because a pooled connection would carry it to
the next request. The server **refuses to start** if its own database role could bypass row-level
security. A six-lens adversarial review of the first cut reproduced a cross-tenant privilege
escalation against a live database; migration 0003 closes it by splitting every policy by command,
so the branch that lets an account see its own memberships can never be used for a write.

**Two custodies, as of 0004 and 0005.** Operators hold the machine; stewards hold the data. A
composite key onto `principals (id, kind)` makes an operator **unrepresentable** in an authority row
— proved by a test that connects as a full-privilege superuser and still cannot do it, because this
is a constraint rather than a policy. The operator database role has `SELECT` on eleven tables (the list is `OPERATOR_MAY_SELECT` in `tests/planes.rs`) and
nothing else, and every policy added for it is `FOR SELECT`, never `FOR ALL`. The application's
database password is generated at first start into the key volume and appears in neither the compose
file nor the environment.

**The engine seam.** As of 2026-09-12 the server depends on `fathom-schema`, `fathom-graph` and
`fathom-id`. It loads the `schema/` tree once at startup and serves `GET /schema/kinds` off the
loaded tree. Before this, the two halves of the codebase shared nothing. `fathom-graph` and
`fathom-id` have no caller yet.

**The dependency gate.** Six layers, none redundant: approval records per crate, licence and source
allowlisting with duplicate-version bans, the RustSec check, lookalike-name detection, a publication
cooldown, and — new on 2026-09-12 — `scripts/osv-gate.sh`, which sends every (name, version) pair in
the lockfile to OSV.dev, where RustSec and the GitHub-reviewed advisories are aggregated, because
two real advisories were missing from RustSec alone (`docs/PHASE-2-STORAGE-DESIGN.md` §12.5). It
fails closed when the API is unreachable, which it is from this environment. Read the crate count
off `./scripts/gate-zero.sh`, not off this line. `cargo deny` and `cargo audit` were both run
in-repo on 2026-09-12: 0 vulnerabilities, 0 warnings.

**Key handling.** Decided, ratified and now built: a data key per tenant and per design, wrapped by
a master key, custody switched by re-wrapping keys rather than re-encrypting data. Re-wrap and
rotation have separate columns and separate words, and no setting accepts one as a synonym for the
other.

---

## The browser client

Built at `client/` in React, Vite and React Flow; typecheck, tests and build green, `gate-npm` green.

- **Two doors.** Sign-in with a key this browser holds, and enrolment, which redeems an invitation
  and generates a non-extractable account keypair stored under a pending slot *before* the request
  goes out, promoted on a confirmed answer, so a key the server has accepted is never lost.
- **The shell of ADR-0047**: the one-row bar, the path that opens the scope tree, the five lenses,
  search that collapses to its magnifier, presence, undo and redo (disabled: nothing changes the
  graph through them yet), zoom, the account menu; the rail folded to a strip that opens to the
  palette; an editor absent when nothing is selected.
- **Home**, listing your organisations and the designs you may open grouped under their closet's
  name, landing an account with one place to go directly there.
- **The Racks place** (Session 4). Opening a design fetches the catalogue and the payload, reads the
  plain face (ADR-0049) into the browser's document, and draws it with React Flow: racks with rails,
  U numbers and hatched free runs; device boxes with name and model; ports from the catalogue's
  faceplates fading in toward the faceplate stop. The camera has seven stops named on the interface
  page (UI-SPEC "The shape"); the client stops at four of them so far, derived from the approved
  boards — closet 87.5%, rack 100% (one 42U rack fits), faceplate 200%, inside 300%. Dragging a palette
  item onto a rack snaps to a unit, refuses an overlap with a shake, and places the device, its
  chassis and its ports; a chassis drags within or between racks. Every change saves: one save in
  flight, the latest queued, a refusal shown and never rolled back. The TypeScript writer reproduces
  all three Rust-made vectors byte for byte, and the server reads every payload back before storing it.

- **Cables** (Session 5). Connect two ports by dragging: the live droop, only compatible ports stay
  live, one cable per port, the colour picker on release with the last-used sheath preselected.
  Cables draw with the sag, the sheath as the stroke, copper one stroke, fibre a pair, power heavy in
  the opposite lane; a cable leaving the closet ends in a dashed portal tray naming where it goes.
  Cables sharing both ends bundle with a count and fan open on hover; a hovered or selected cable
  lights its whole path through a panel and a portal while the rest sits at the phantom opacity.
  PSU inlets on the rail, filled when fed, the single-fed wash, a PDU's n of m used; a front | rear
  flip at the rack stop and rear chassis stacked at the faceplate stop. The editor edits hostname,
  role, management address and serial, first press selects, second edits, typed values marked and a
  refused value said out loud. The catalogue has an APC PDU and two Panduit panels, cited.

- **The rear elevation** (Session 6, first, ADR-0050). Schema 0.7: a rack in a row and bay, a
  supply as a part in a slot with its own serial, hosting its inlet port. The catalogue records
  each supply slot on its face at its position with a hot-swap flag, and management and console
  ports by name; the EX4300's me0, con and both slots are on the rear, cited. The drawing has two
  elevations of every rack, mirrored from behind with faceplates as the vendor draws them; the
  closet stop lays racks out by row and a row flips as one camera, bays reversed; inlets draw in a
  strip in three states and the marks *single-fed* and *one fitted* are derived; the editor fits or
  removes a supply and sets a rack's row and bay.

- **Shelves, surfaces and sketches** (Session 6(b), ADR-0051 §1–2, schema 0.8). A shelf takes
  units and its occupants take slots; a device or passive is fixed to a wall, floor, desk or ceiling,
  or to a board on a wall, at millimetres; a device with no catalogue entry carries ports typed by
  hand and says so; a port records its face; an outlet box or panel gets its pass-through pairs at
  placement and a lit path follows them. The drawing mounts the shelf plate in both elevations,
  surfaces as flat panels beside the rows with a not-measured strip, the floor as a band; cables
  resolve on occupants and fixtures; the editor shows either with the placed-on control. The
  catalogue has a Tripp Lite shelf, an ICC outlet box and a CyberPower UPS, cited.

- **The config drawer, view-only, the inside stop** (Session 6(c), ADR-0052, schema 0.9). The
  redaction module ships as a file and runs in the browser with no packages; a paste goes through
  the gate before anything reaches the document, and a driven browser run proves seven
  credentials of real device length absent from every save body. The drawer sits under the dimmed
  faceplate with the three gutter marks, a black block where a value was destroyed, the six rules
  printed, a lit port for a built line; the capture is a node on the device and the marks derive
  from provenance on reopen. A reader sees a view-only chip and text only, and the server refuses
  a read account's save. The inside stop draws a firewall's zones, interfaces, policy rail,
  routes and tunnels from the module's own inside door, never a verdict.

- **The inventory, notes, undo that records** (Session 6(d), ADR-0053, schema 0.10). Two places
  over one opened design sharing the document and the save queue; the inventory's rail of kinds,
  the device grid grouped per rack with the lens choosing the columns, the Gaps section, the page
  as the one editor, Show on rack both ways. A note is a node on a device, port or rack, pasted
  through the gate by its own door or stored as typed and saying so. An undo is a new batch of
  reversing operations with a revive operation for what a tombstone removed; only your own
  batches, a colleague's later change refuses by name; the trail beside the drawing with sealed
  and pending, a comment on the next change, the chips and keys live.

- **A save carries its base; a drawer creates a design; a steward creates a scope** (Session 7,
  ADR-0054, schema unchanged). A save names the version it was based on; the server refuses a base
  that is not the current version, naming both numbers, writes nothing, and the client keeps its
  own base rather than adopting the server's. `POST .../scopes/{scope}/designs` (draw creates a
  design) and `POST .../scopes` (a steward of the parent creates a scope) mean a design is
  reachable from a fresh deployment. The refusal wash names the change and offers a Reload button.
  From the checker's round on the whole surface: the server refuses a payload whose capture or note
  text still looks like a credential; save, open, verify and create re-check the grant inside the
  acting transaction; a body is capped at one mebibyte until the signature is checked; the list
  handlers verify authority once per organisation; behind the proxy the client address is the
  last entry of a header Caddy overwrites; the compose image copies the corpus and serves the
  client through Caddy, unproven here where no daemon runs; the single-operator flag is read at
  apply. A driven run from sign-in proved a scope and a design created from Home, a save, and a
  second browser's stale save refused. The same day, from the owner: a cable's panel with the
  colour selector and the ends, ports selectable with Select cable and Go to far end, a cables
  view control by kind, and the wrong-drop shake on a port.

**Carried:** the dependency-vulnerability gate needs a machine with egress to the advisory
database (`scripts/osv-gate.sh`), and the v0.1 tag waits on that run;
the server's credential check is the detector only, with SNMPv3 auth and priv values a known
residual until dictionary matching runs on the server (W7); nothing yet exercises two genuinely
concurrent saves, which the row lock serialises by construction; the trail's sealed mark is an idle-time approximation until the session hook exposes
save completion; the comment box should attach to the next batch, not an already-recorded one; a
note's line count is taken before the gate; the new wire shapes have no cross-language vector
yet; saved filters and the grids for racks, cables and ports are named and unbuilt; the private
notes layer arrives with the vault (W6). Replacing a capture (a second paste into the same device
is refused until then); the drawer tags every built line and should show them on hover only; a
successful paste has no confirmation pulse yet; a Proxmox host needs a dictionary and guest and bridge kinds; unreachable-policy hatching and
the assistant panel; dropping a board onto a surface is a no-op until the drawing has a surface
drop zone; the opened occupant can sit under the editor; a panel's label pairing remains as the
fallback when no pass-through edge exists. Optics (ADR-0047 §5). The left-right order of the
EX4300's two supply slots could not be established. The "two people on a running server" proof,
which tests and screenshots still stand in for. The old Rust-assembled HTML client is retired and still on disk under
`crates/fathom-artifact/`; it is not served.

---

## Never built

- Walkthrough view — the teaching half of the product.
- Config view.
- The building and room stops — decided (UI-SPEC "The building", ADR-0051), not built.
- Engine manager — how equipment types are registered and kept current.
- Automatic correlation across separately-pasted configs.
- Anything that discovers a network live. Everything today comes from pasted text.

---

## Known limits worth remembering

**The compose stack is run end to end by CI, as of 2026-09-19.** `compose.yaml` sits at the
repository root; `docker compose up -d` with one variable in `.env` is the whole instruction
(`docs/RUNNING-IT.md`): it pulls the two images `publish.yml` pushes to GHCR from every merge to
`main`, and `--build` builds the same stages from the checkout. A one-shot `keys-init` container generates the two root keys
and the three database passwords into the `keys` volume, which closed the last two first-start
faults: keys that had to be generated by hand into a read-only volume, and a database init script
that could not write into a root-owned one. `.github/workflows/ci.yml`'s `compose` job builds the
images, starts the stack, checks health and the client through Caddy, reads the first-operator
token and proves a restart keeps its keys. The root `Dockerfile` and `docker-compose.yml`, which
packaged the retired single-file client, are deleted; `publish.yml` now publishes
`deploy/Dockerfile`'s `server` and `caddy` stages as `ghcr.io/keyxmakerx/fathom-server` and
`fathom-caddy`, and runs its test floor against a database, which it never had.

**The test suite needs a fresh database, and that is now measured rather than assumed.** Every test
running against one database shares its global state — triggers, rate-limit buckets, the site chain,
the settings rows. See `docs/NEXT.md` rule 3 for the isolation requirements.

On 2026-09-16 the suite was run repeatedly against a single database to see how far that goes. On a
fresh database it passes; reused, it fails intermittently, and three separate causes were found:

- **A rate-limit bucket at `127.0.0.1`.** `tests/sessions.rs`'s HTTP sign-in helper trusted no
  forwarded-for header, so every sign-in it made counted against the peer address, and the counter
  outlives a `cargo test`. The challenge answered `429` instead of `200`. **Fixed**: the helper now
  takes a source of its own, as rule 3 requires of anything global.
- **A one-second session lifetime** in `an_expired_session_is_refused_and_the_row_goes_with_it` had
  to cover signing in *and* taking a nonce, both real round trips, so on a loaded machine the
  session expired before the test reached the refusal it exists to check. **Fixed**: four seconds.
- **`an_operator_cannot_be_seconded_by_the_operator_they_created`** read `captured` where it
  expected `first`. Recorded on 2026-09-16 as a reused-database fault; on 2026-09-19 it failed
  on a fresh database under a full workspace run, and the cause was read off the store: the
  fixture ran in single-operator mode, under which an unseconded change applies alone once its
  one-second delay passes, so the assertion raced the round trips. **Fixed**: the fixture
  requires a second signature, as the two-operator control test already did.
- **`past_the_bound_a_rotation_is_refused_and_drains_to_succeed`** fails only on a reused
  database, confirmed to fail identically at the commit before 2026-09-16's work. **Not fixed.**
  It costs nothing under rule 3, which gives every builder its own database, and CI creates one
  per run.

**`tests/operators.rs` leaves a database behind per test.** Its per-test fixture creates
`fathom_isolated_*` databases and does not drop them; twelve were found after one run on
2026-09-16 and dropped by hand. Harmless in CI, which discards the cluster, and a slow leak
anywhere else. Not fixed; the fixture is the place.

**The server refuses to start on a broken schema, deliberately.** `EngineState::load` runs every
gate and will not serve a vocabulary that fails one. A broken tree is now a startup failure naming
the gate and the file, exit 7. `deploy/Dockerfile` copies `schema/` into the distroless runtime
stage from the build stage, so the image ships exactly the tree it was built against.
`FATHOM_SCHEMA_ROOT` overrides the path.

- **Typed values are not redacted.** The gate runs on paste only. A password typed by hand into a
  field is stored and exported as written — it gets a warning mark beside it, and that is the
  decision, not a bug.
- **Engines, as of 2026-09-19, are files in the tree.** ADR-0044 describes signed data packs;
  none of its Phase 5 exists: no `engine.yaml`, no signature, no install, no chain entry, no
  pinning. The server reads `corpus/catalogue/` from disk at start and the client compiles
  `corpus/dict/` into its bundle. What the corpus carries for the owner's stack, every device fact
  cited with its read date, every credential test at the length the device accepts:
  - **Juniper.** `junos-srx` is the one dictionary with real depth (a branch config binds about
    57% of its lines). `junos-ex` binds VLANs, ethernet-switching membership, LAG membership and
    irb units; `interface-mode` is left unbound on purpose (per-edge fact, per-unit statement);
    a virtual chassis has no schema representation. Catalogue: EX4300-48P, EX2300-48P,
    EX4100-48P (its SFP28 uplinks recorded as SFP+ for want of a kind), SRX300, SRX340 (1U; the
    vendor page wins over the design board).
  - **OPNsense.** The rules-migration CSV (26.1 and later) is the only readable export and the
    only one bound. Aliases export as JSON; `config.xml` needs an XML framer, and the fields it
    must destroy are listed in `corpus/dict/opnsense/README-config-xml.md`. The dictionary
    declares no secrets; the core floor destroyed every credential driven at it. No catalogue
    entry: the catalogue has no form for "a box that runs OPNsense".
  - **Ubiquiti.** Catalogue: UDM-SE, USW-24-PoE, USW-48-PoE (their 1G SFP cages recorded as
    SFP+ for want of a kind). UniFi has no human-readable export, so no dictionary
    (`corpus/dict/README-ubiquiti.md`). EdgeOS binds hostname, interface description and
    disable, and `vif` sub-interfaces from `show configuration commands`; base interface
    addresses, static routes, DHCP server and NAT are unbound for reasons written in the files.
  - **Linux hosts.** A zero-entry dictionary. `ip` and `bridge` output is not verb-initial and
    `shape.rs` shapes only `set` lines, so nothing binds until the core grows a record-shaped
    front end (`corpus/dict/README-linux-host.md`); a pasted WireGuard private key is still
    destroyed. Teaching: `linux-family-basics` and eight per-flavour explainers (Arch, Debian,
    Ubuntu, Fedora, the RHEL family, openSUSE, NixOS, Alpine) cited from each distribution's
    own documentation, recommending nothing beyond the platform's own package manager and init.
  - **Arista.** Catalogue: 720XP-48ZC2, 7050SX3-48YC8; an EOS explainer. No dictionary: EOS
    block config is the same shape gap as Linux, and the safety net destroys every credential
    in a 120-line synthetic config (`crates/fathom-ingest/tests/arista_eos.rs`).

  Every explainer written that day carries `reviewed_by: <named human>`, which means unreviewed;
  no client surface shows that label yet (OPEN-QUESTIONS E2 is answered, not built).

  **Gaps the verification found, carried:** the client boots one dictionary beside OPNsense
  (`shell.rs` holds a single slot), so `junos-ex` and `edgeos` are compiled in but not booted,
  listed in `engine.ts` as excluded with reasons and a test that refuses a silent omission; the
  redaction-unproven refusal of ADR-0044 rule 2 is not built, the core floor is the only fence
  (amended in the ADR); a credential typed into the free-text description cell of the OPNsense
  CSV is not caught, pinned by a test in `opnsense_csv.rs`; the `<named human>` placeholder is
  a warning, not a build failure, because the shipping gate does not exist; a dictionary cannot
  bind `lacp_mode`, an interface form or a `NextHop` (`ValueTy` has no arm); the catalogue has
  no plain SFP or SFP28 kind. **Closed the same day:** `secret_exempt` could be declared by any
  dictionary with a free-text reason and let a cleartext password bind; it is now honoured only
  for the path shapes a core-held allowlist names, with a canary that drives a real SRX password
  through the rogue entry; empty citations and reviewers are refused; every dictionary file
  carries a `source` header and a reviewer.
- **Nothing creates cables or ports from a config.** Only by hand.

---

## Reference

`/home/user/pouzor/homelable` — a smaller, well-built homelab visualization tool being used as a
reference for the client rebuild. React, and it solves several problems we hand-built.
