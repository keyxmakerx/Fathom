# What comes next — the plan from 2026-09-13

**Read this after `CLAUDE.md` and `docs/STATE.md`, and before starting any session.** It says what
to build, in what order, with which helpers, and what it will cost. It is written for a session
running on Opus, so every decision it relies on is named with its file, and nothing here asks the
session to decide something already decided.

**The target: a first usable version.** A person signs in, lands on a home page, draws a rack-first
network diagram, saves it, finds it again in a basic inventory, and shares it view-only with a
colleague, on the Docker stack, with the security foundation already built underneath. *Home and a
basic inventory joined the target on 2026-09-15 (ADR-0046 §8).* Roughly six to nine sessions of the size of 2026-09-12/13.
The vault, live multi-user editing, inventory, teaching, groups and LDAP come after, and are a
comparable amount again.

---

## Ground rules for every session that executes this

1. **Cost first.** A full attack round on a layer cost 250–350k helper tokens; an opus build
   400–550k. Spend those only on code that holds keys, grants, sessions or ciphertext. The canvas
   and the client get sonnet builders and one cheap review each, not four attack rounds.
2. **Models.** `builder` on sonnet when the brief is settled (it is, for everything below unless
   marked *judgement*); opus only where marked. `checker` and `security` stay on opus; use them
   narrowly and once. `bookkeeper` on haiku for STATE.md and number checks. `designer` only for a
   surface `docs/UI-SPEC.md` does not draw.
3. **Isolation.** Every builder that touches `crates/` runs in a worktree
   (`isolation: "worktree"`) and in
   its own database: create it as the superuser, point `FATHOM_MIGRATE_DATABASE_URL` and
   `SUPERUSER_DATABASE_URL` at it, and drop it after. Never `fathom_test`.
   **`DATABASE_URL` is the exception and an earlier version of this rule got it wrong.** It names
   the RUNTIME role, `fathom_app`, and must never be given the superuser's URL: PostgreSQL exempts
   a superuser from row-level security unconditionally, so every tenant-isolation assertion in the
   suite would pass whether the policies work or not, and two of them fail outright. Leave it unset
   and the harness derives the runtime connection itself, exactly as `.github/workflows/ci.yml`
   does. A builder hit this on 2026-09-14 and reported it rather than working around it. **A test
   that shares the database shares every global in it.** Two of these bit on 2026-09-13: a
   table-wide `DISABLE TRIGGER` window opened by hand instead of through `support::tamper`'s
   advisory lock (CI failed; `support::hold_the_tamper_lock` is the fix), and a rate-limit
   bucket keyed on one hard-coded source address shared by every sign-in test. Anything global —
   a trigger, a counter, a window, the site chain — needs a lock or a key of its own.
4. **Commits.** Builders never commit. The lead commits with an explicit pathspec
   (`git commit -- <paths>`) after running the gates itself, then merges the worktree branch, then
   pushes. A commit that has not passed `cargo test --workspace --locked` on a fresh database is
   not pushed. Nothing is pushed to any branch but the designated one.
5. **Documents win, and they are the lead's.** Builders report where a design was wrong or silent;
   the lead writes the correction into the design with a date and reason. Every label in code is a
   row in `docs/PHASE-2-STORAGE-DESIGN.md` §12.2. An applied migration is never edited (its bytes
   are under a checksum); corrections go in the next migration's header.
6. **Never from memory.** A security fact is looked up and cited with a date, or written as "could
   not establish". The four forbidden sentences in `CLAUDE.md` apply to every user-facing string.
7. **The PostgreSQL in this environment** is the packaged cluster at
   `/var/lib/postgresql/16/main`, serving `127.0.0.1:5432`, with roles `fathom_test`
   (NOSUPERUSER CREATEROLE), `fathom_app` and `fathom_operator`, and database `fathom_test`.
   **Corrected 2026-09-14:** this rule used to describe a cluster started by hand under
   `/var/tmp/fathom-pg`. That one is gone. A builder found the packaged cluster installed and
   stopped, started it, and changed loopback authentication in its `pg_hba.conf` from
   `scram-sha-256` to `trust` so that the superuser workflow these briefs describe would work.
   Two clusters competing for one port is also the likeliest explanation for the cluster that
   disappeared mid-session that day. If PostgreSQL is not running, start **that** cluster rather
   than creating another. Trust authentication on loopback is acceptable only because this is a
   disposable container; it is not advice for anywhere else. `cargo-deny` and `cargo-audit` are
   installed with `cargo install --locked`. `api.osv.dev` is blocked here; `scripts/osv-gate.sh`
   fails closed and must be run where CI has egress.
8. **Every brief opens with the base check, and this is the lead's job, not the builder's.**
   Worktrees are cut from `main`, and `main` falls behind the working branch the moment the first
   commit of a session lands. Put this at the top of every brief, verbatim, before anything else:

   > Run `git rev-parse --short HEAD` and `git rev-parse --short <branch>`. If they differ, run
   > `git merge --ff-only <branch>` and confirm it succeeded. Do not build until they match.

   On 2026-09-14 three builders were launched against a base four commits stale: two of the files
   one of them was told to read did not exist, the migration number it was given would have
   collided, and the security-bearing file it had to extend had been rewritten in the gap. It
   stopped and said so, which is the right behaviour and cost a build anyway. The lead can also
   fast-forward a clean worktree from outside it, which is the fix when a builder is already
   running.

---

## Session 1 — Close the server foundation

**Goal:** the last security-bearing server code is attacked and the admin console exists, so that
a person can be invited, enrol a key, and sign in.

1. **Attack the sign-in layer** (opus `checker`, one round, narrow). Migration 0013, `sessions.rs`,
   `api.rs` — the same questions as the authority rounds (admin design §3.8 lists them): nothing
   trusted from the client that is not signed or re-derived; nonce reuse; a session row minted
   from SQL; a retired key or disabled account stopping at the next request; the operator
   surface accepting no password-shaped input. Fix what survives with an opus builder; a second
   narrow pass only if the fixes touched the signature message or the row MAC.
2. **Read the builder's silent-spot decisions into the design** (lead, cheap). The sessions
   builder decided rate limiting, lockout and the token shape where admin §4 and §13 were silent;
   those decisions live only in code comments. Write them into §4 and §13 with a date.
3. **The admin console, minimal** (opus builder — *judgement*: it is the takeover surface). Admin
   design §1, §5, §6.2, §15.0. Operator sign-in on the operator plane with the same key mechanism
   as accounts and no password path (§4.5); account shells and **enrolment tokens by email**
   (OPEN-QUESTIONS B5: invite only — nobody self-registers); organisation shells and their
   enrolment claims (§6.2, §6.3); SMTP and site settings behind the execution interlock (§5.3,
   §5.4, §5.5 — two operator assertions plus delay, or the documented single-operator mode);
   the operator suspend verb (§1.1) made real; every act a sealed site-chain entry. Reset (§5.1)
   is an enrolment token to the address of record — there is no password to reset.
4. **The account side of enrolment** (same builder): redeem a token, generate the keypair in the
   browser, enrol it (`grants::enrol_software_key`), sign in. WebAuthn stays deferred (§15.4).
5. **Run the Docker stack end to end** in an environment with registry access
   (`deploy/compose.yaml`): first start generates the master key and the role passwords; the
   server refuses a superuser role; a design round-trips. Record the result in STATE.md — this has
   never been done and STATE.md says so.

**Done when:** an operator invites a person by email, that person enrols a key and signs in, and
every step is on the site chain. Cost: one checker round, one or two opus builds. ~1.2M tokens.

## Session 2 — The endpoints the client needs

**Goal:** the server can open, change and save a design for a signed-in person with the right
capability, and list what they may see.

Sonnet builder, one cheap review. Design list per scope filtered by `grants::authorise_account`;
open (returns the decrypted design and its version); save (a new version through
`designs::write_version`, refused past the spool bound with the typed error surfaced); history and
`verify` for a design (storage §11.2's three outcomes, named); all behind the session layer from
0013. `GET /schema/kinds` already exists. Presence and live editing are Phase 4 and are not touched.
Also: the equipment catalogue format and a Juniper catalogue for the models on the approved boards
(ADR-0044, `docs/decisions/adr-0044-*`) — the canvas draws ports from it, so it lands here.

**Done when:** a signed-in account with `draw` saves a design and one with `read` opens it and is
refused a save. ~500k tokens.

## Sessions 3–6 — The canvas

> **Amended 2026-09-15, ADR-0046.** The client has two places, *Racks* and *Inventory*, plus *Home*,
> and one editor shared by the drawing's inspector and the inventory page. Before Session 4 starts,
> the undrawn screens listed in `docs/UI-SPEC.md` "Not yet drawn — the screens" are sketched as one
> set, so navigation is decided once. Session 3's shell gains the two-place masthead and Home;
> Session 6 gains the basic inventory (lists, the page, *show on rack*), notes on a device, and
> undo-that-records. The patching surface, maintenance records and the building stop come after the
> first usable version.


**Goal:** the product. `docs/UI-SPEC.md` is approved; build against it and open the linked pictures
only for the surface being built. React + Vite, plain CSS from `design/tokens.css`, React Flow.
The redaction gate is `crates/fathom-wasm`, compiled for the browser, zero external packages
(OPEN-QUESTIONS A3) — never reimplemented in JavaScript.

Sonnet builders throughout, one per surface, one cheap review each; designer only for a surface
the spec does not draw. In order:

- **3.** App skeleton and sign-in: tokens, layout, the WebCrypto session keypair (non-extractable),
  challenge, request signing on every call (the message in `sessions.rs`, label
  `fathom/session/req/v1`), enrolment-token redemption. Design list.
- **4.** The rack: the shape (§"The shape"), faceplates and ports from the catalogue (§"Ports"),
  the palette, place and move, pan and zoom, save and load through Session 2's endpoints.
- **5.** Cables and portals (§"Cables", §"Keeping it readable at forty cables", §"Portals"),
  drag-to-connect, power (§"Power").
- **6.** Inside a box (§"Inside a box"), the config surface (§"Config") with the redaction gate
  on paste — test the gate against what a real device accepts (CLAUDE.md rule 2) — view-only
  rendering for `read`, motion and look (§"Motion", §"Look").

**Done when:** you can build a network diagram from nothing, by dragging, and it saves, and a
colleague with `read` sees it and cannot change it. ~400k tokens per session.

## Session 7 — Hardening and a release candidate

- One opus `checker` round on the **HTTP surface as a whole**, now that proposals and sessions
  cross a real trust boundary (admin §3.8's standing question).
- `scripts/osv-gate.sh` and the full gate list where egress exists; `./scripts/forbidden-claims.sh`
  over the client's strings.
- The operator documentation ADR-0043 §9 requires, in its register: the key file, the backup
  recipe that never archives key and database together, restore with the key-id stamp, `rekey`.
- STATE.md by the bookkeeper; tag `v0.1`.

~600k tokens.

## After the first usable version, in this order

1. **The vault** — storage §13; primitive decided (§13.7: P-256 ECDH + HKDF + AES-GCM in
   WebCrypto). Three surfaces are not drawn (UI-SPEC "Not yet drawn"): designer first. Read
   IACR 2026/058 and SP 800-57 before shipping; both were unreachable.
2. **Groups** — admin §3.7: design the tables and signed bytes, one attack round, then build.
   Stewardship never flows through a group; sync provisions membership only.
3. **Live multi-user editing** — Phase 4; the two-container rule (REBUILD-PLAN operational
   foundations item 1) already forbids in-process state.
4. **Receipts, witness, break-glass, WebAuthn** — admin §7.4–§7.6, §8, §15.4; §15.2's Shamir.
5. **Inventory, teaching, the config checker** — Phases 5 and 6. **LDAP** after groups.

---

## Decisions an executing session must not reopen

Each binds until overruled on merit in writing (`CLAUDE.md` rule 6):

- Master key is a file, provider `file://`/`command://`/`env://`; vault takes two secrets —
  ADR-0043.
- Engines are signed data packs, never code — ADR-0044.
- ChaCha20-Poly1305 with random nonces and mandatory per-design keys; HMAC-SHA-256 chain MAC;
  HKDF-Expand subkeys — storage §12.3, §12.4.
- The seal covers metadata as stored plus a keyed binding — storage §11.2 (corrected).
- Re-wrap is deployment-wide in one transaction — storage §12.6 (clarified).
- Operators cannot grant; stewards inside the organisation do — admin §1, §3.
- Grants are signed, quorum is one qualifying seconding, the sole-steward flag is in the signed
  bytes, a proposal is not evidence of itself, single-steward acts against a steward take 24 hours
  — admin §3.5, §3.8.
- Hardware authenticators not required for v1; ES256 with `p256`/`ecdsa`; WebAuthn hand-written
  — admin §15.
- Invite only (B5); the owner writes vendor knowledge as they go (B10); unreviewed engine items
  shown, labelled (E2); name formatting is groundwork only (D8) — OPEN-QUESTIONS.
- Browser side: zero external packages (A3). Server crate cap 200, revisit at 180.
- Two places, one editor, undo that records, comments sealed with the change, maintenance records,
  suggestions never recorded as facts — ADR-0046. Firmware by the device pulling — ADR-0045.
- **Reopened, on merit, by the owner:** the building view (ADR-0046 §4). It is a zoom level, not a
  parked idea.

## Questions only the owner can answer (none block Session 1)

- Is a 24-hour delay on one administrator removing another right for a two-person team?
  (Admin §3.5's dated block states the cost; the operator's instant suspend remains.)
- Which directory comes first when sync is built: LDAP as stated, or Active Directory — the door
  is the same, the first connector is not.
