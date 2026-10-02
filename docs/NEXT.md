# How to work on Fathom

**Read this after `CLAUDE.md` and `docs/STATE.md`, and before starting any session.** It says how to
work. It no longer says what to build: that lives in two places only.

- **The plan:** `docs/decisions/adr-0060-one-canvas-detail-by-degrees.md`, step by step, with the
  order the owner approved on 2026-10-02 (one small pull request per step, each started on the
  owner's go).
- **The backlog:** GitHub issues. A new ask becomes an issue. Issues labelled `later` wait until
  ADR-0060 is done.
- **Questions for the owner:** the sign-off page (ADR-0060, decision 9). It opens on the questions
  still waiting; answered ones move out of that view.

*Cut down on 2026-10-02.* The handover log, the session plan and the "after the first usable
version" list this file used to carry were overtaken by ADR-0060 and the issues. The last full
version is `docs/archive/2026-10-02-NEXT-md-before-cleanup.md`.

**"Usable" means beta** (the owner, 2026-09-22): polished, the app basically done, a few features
allowed to be missing, and the owner reaches a saved diagram unaided. Green gates do not grant it;
a walkthrough by the owner does.

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
   not pushed. Nothing is pushed to any branch but the designated one, except backups: all
   unfinished work goes to one branch, `claude/wip`, overwritten every few minutes, one worktree
   per parent of its commit (the owner, 2026-09-26, after a machine reset lost unpushed work). A
   session cannot delete a branch, so no other backup branch is made.
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
