# What is actually built

**Last confirmed:** 2026-09-18: 1234 server-side tests and 595 client tests, read off the runs. Read numbers off a real run, not off this page.

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
  faceplates fading in toward the faceplate stop. The camera has three stops derived from the
  approved boards — closet 87.5%, rack 100% (one 42U rack fits), faceplate 200%. Dragging a palette
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

**Carried:** a shelf cannot be named yet and the editor shows its id; a sketched device and a board
have no create command in the palette, only in the document; a board fixed with no position hides
what it carries; the opened occupant can sit under the editor; a panel's label pairing remains as
the fallback when no pass-through edge exists. Optics (ADR-0047 §5). The left-right order of the
EX4300's two supply slots could not be established. The "two people on a running server" proof,
which tests and screenshots still stand in for. The old Rust-assembled HTML client is retired and still on disk under
`crates/fathom-artifact/`; it is not served.

---

## Never built

- Walkthrough view — the teaching half of the product.
- Config view.
- Inventory place — the lists and the page; the designer surface (ADR-0051) lives here.
- The building and room stops — decided (UI-SPEC "The building", ADR-0051), not built.
- Engine manager — how equipment types are registered and kept current.
- Automatic correlation across separately-pasted configs.
- Anything that discovers a network live. Everything today comes from pasted text.

---

## Known limits worth remembering

**The compose stack has not been run end to end.** `deploy/compose.yaml` and the initial setup
scripts were verified by mechanism on 2026-09-12. Two first-start faults were found by reading it:
the first is fixed (the bootstrap token now has its own writable volume, separate from the read-only
key volume); the second requires manual action (generate the two keys before the first `compose up`).
Both are documented in `docs/RUNNING-IT.md`. **Run `docker compose up` from a clean checkout
somewhere with the keys pre-generated before calling deployment proven.**

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
- **Two tests still share state across runs** and fail only on a reused database:
  `an_operator_cannot_be_seconded_by_the_operator_they_created` (a settings row reads `captured`
  where it expects `first`) and `past_the_bound_a_rotation_is_refused_and_drains_to_succeed`. Both
  were confirmed to fail identically at the commit before that day's work, so neither is new. **Not
  fixed.** They cost nothing under rule 3, which gives every builder its own database, and CI
  creates one per run.

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
- **Juniper is the only platform with real content behind it.** Five others are registered and
  empty. A pasted Juniper branch config binds about 57% of its lines.
- **Nothing creates cables or ports from a config.** Only by hand.

---

## Reference

`/home/user/pouzor/homelable` — a smaller, well-built homelab visualization tool being used as a
reference for the client rebuild. React, and it solves several problems we hand-built.
