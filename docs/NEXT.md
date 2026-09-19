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

## Handoff — read this first (updated 2026-09-18)

Sessions 1 to 5 are done; Session 6(a), the rear elevation, 6(b), schema 0.8 with shelves,
surfaces and sketches, and 6(c), the config drawer with the gate in the browser, view-only and the
inside stop (ADR-0052, schema 0.9), are in (2026-09-19). **Next is Session 6(d)**: the basic
inventory, notes on a device, undo that records; then Session 7. For the record, 6(c) was: inside
a box, the config surface with
the redaction gate on paste (`crates/fathom-wasm`, never reimplemented in JavaScript; test the gate
against what a real device accepts, `CLAUDE.md` rule 2), view-only for `read`, motion and look.
Read first: `docs/STATE.md`'s client section and its "Carried" list; ADR-0050 and ADR-0051;
`docs/UI-SPEC.md` "Places", "Motion", "Look"; `client/src/document/` and
`client/src/components/drawing/`. `docs/archive/` stays closed.

Sessions 4 to 6 ran as parallel sonnet builders on disjoint files against a contract written into
each brief, joined by the lead, with screenshots as the proof. That shape worked: keep it. Four
rules the owner did not object to (ADR-0047 §9): an expected link with unknown ends is drawn dashed
and listed as a gap; names clip in the middle and never shrink; the name stays left and the model
shrinks first; one lens at a time.

Four things learned that the rules above do not say:

9. **Commit with `-F <file>`, never `-m "..."`.** Backticks in a quoted message are run by the
   shell; a merge commit was garbled that way on 2026-09-13.
10. **`pkill -f fathom-server` kills your own shell** when the pattern appears in its command line.
    Use `pgrep`, `curl`, and `fuser -k <port>/tcp`.
11. **Boards are checked by rendering them**, not by reading them: headless Chromium is at
    `/opt/pw-browsers/chromium`; a ten-line Playwright script screenshots a `.dc.html` at 1440
    wide. Every overlap and clipped label was found in a screenshot.
12. **A Rust builder's worktree builds its own `target/`, and the disk is a fixed allowance.** Give
    every Rust builder `CARGO_TARGET_DIR=/home/user/Fathom/target`, remove a worktree the moment
    its files are taken across, delete logs as you go. Two builders regenerating the same crate can
    hand each other a stale artefact; `cargo clean -p <crate>` and a rerun settles it.
13. **No drawing change is committed without a screenshot through the real component.** Three
    defects in one week passed every report and every test and were caught only by rendering: a
    plate built and never mounted, cables dropped by a resolver, a 1U plate with nothing on it.
    A harness that mounts a component directly proves the component, not the drawing.

## Sessions 1 and 2 — done

The server foundation (sign-in attacked, the admin console, enrolment by email) and the endpoints
the client needs (list, open, save, history, verify; the catalogue format and the first Juniper
entries). `docs/STATE.md` says what stands.

## Sessions 3–6 — The canvas

> **Amended 2026-09-15, ADR-0046.** The client has two places, *Racks* and *Inventory*, plus *Home*,
> and one editor shared by the drawing's inspector and the inventory page. The screens were drawn on
> 2026-09-15 and the shell on 2026-09-16; **the shell is approved (ADR-0047, `design/shell/`) and
> Session 3 builds it**: the one-row bar, the folded strip, the editor as a surface, the tree from
> the path, the lens row. Home and the other surfaces come from the screens set with the shell's
> bar. Session 3's shell gains the two-place bar and Home;
> Session 6 gains the basic inventory (lists, the page, *show on rack*), notes on a device, and
> undo-that-records. The patching surface, maintenance records and the building stop come after the
> first usable version.


**Goal:** the product. `docs/UI-SPEC.md` is approved; build against it and open the linked pictures
only for the surface being built. React + Vite, plain CSS from `design/tokens.css`, React Flow.
The redaction gate is `crates/fathom-wasm`, compiled for the browser, zero external packages
(OPEN-QUESTIONS A3) — never reimplemented in JavaScript.

Sonnet builders throughout, one per surface, one cheap review each; designer only for a surface
the spec does not draw. In order:

- **3–5, done.** The shell and sign-in; the rack, faceplates, ports, palette, place and move, save
  and load; cables, portals, drag-to-connect, power. `docs/STATE.md` has the detail.
- **6.** In three parts, amended 2026-09-18 (ADR-0051): **(a)** the rear elevation, ADR-0050,
  done 2026-09-16; **(b)** schema 0.8 and the small drawings — shelves and what sits on them,
  surfaces and what is fixed to them, the outlet form, pass-through written at placement, the
  sketch for a device with no catalogue entry, the room's furniture as geometry — shapes before the
  release because a migration after it costs more; **(c)** inside a box (§"Inside a box"), the
  config surface (§"Config") with the redaction gate on paste — test the gate against what a real
  device accepts (CLAUDE.md rule 2) — view-only rendering for `read`, motion and look (§"Motion",
  §"Look").
  **(d)**, added 2026-09-18 on the owner's review of the plan: the basic inventory (lists, the
  page, *show on rack*), notes on a device, undo that records — the three this section's own
  amendment promised Session 6 — plus the carried items that make the shelf unusable from the
  interface otherwise: a palette entry for a sketched device and for a board, naming a shelf, a
  board with no position still showing what it carries.

**Done when:** you can build a network diagram from nothing, by dragging, and it saves, and a
colleague with `read` sees it and cannot change it. ~400k tokens per session.

## Session 7 — Hardening and a release candidate

- **First, not last: run the Docker stack end to end** (`deploy/compose.yaml`) — never done, the
  largest risk to a release. Then have the checker try two browsers saving the same design in turn
  and prove the second save is refused, never a silent overwrite, since live editing comes later.
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
6. **The places track** — ADR-0051, added 2026-09-18; its position in this list relative to the
   vault is the owner's (OPEN-QUESTIONS W1). In order: the designer that draws a model and writes
   it into your own engine, the sketch form first; the room stop with outlets and horizontal runs
   and the path lit from desk to switch; blueprint import, a plan image as a scaled background
   first, DXF walls and labels second, DWG never, vector PDF only if DXF proves insufficient.

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
