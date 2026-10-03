# How to work on Fathom

**Read this after `CLAUDE.md` and `docs/STATE.md`, and before starting any session.** It says how to
work. It no longer says what to build: that lives in two places only.

- **The plan:** `docs/decisions/adr-0060-one-canvas-detail-by-degrees.md`, step by step, with the
  order the owner approved on 2026-10-02. Later rounds are in ADR-0061. The owner prefers related
  work bundled into one PR.
- **The backlog:** GitHub issues. A new ask becomes an issue. Issues labelled `later` wait until
  ADR-0060 is done.
- **Questions for the owner:** the sign-off page (ADR-0060, decision 9). It opens on the questions
  still waiting; answered ones move out of that view.

**"Usable" means beta** (the owner, 2026-09-22): polished, the app basically done, a few features
allowed to be missing, and the owner reaches a saved diagram unaided. Green gates do not grant it;
a walkthrough by the owner does.

---

## Ground rules

1. **Cost first.** The owner prefers slower and cheaper. Heavy review (attack rounds, opus builds)
   only for code that holds keys, grants, sessions or ciphertext; the client gets a sonnet builder
   and one cheap review.
2. **Models.** `builder` on sonnet when the brief is settled; opus for judgement (UI/UX, security,
   architecture). `checker` and `security` narrowly, once. `bookkeeper` for STATE.md and numbers.
   `designer` only for a surface UI-SPEC does not draw.
3. **Isolation.** A builder touching `crates/` runs in a worktree and its own database: create it
   as the superuser, point `FATHOM_MIGRATE_DATABASE_URL` and `SUPERUSER_DATABASE_URL` at it, drop
   it after. Never `fathom_test`. `DATABASE_URL` names the runtime role `fathom_app` and must
   never be the superuser: PostgreSQL exempts a superuser from row-level security, so isolation
   tests would pass whatever the policies say. Leave it unset; the harness derives it, as CI does.
   Anything global in a shared database (a trigger, a counter, a rate-limit window, the site
   chain) needs a lock or a key of its own (`support::hold_the_tamper_lock`,
   `support::lock_the_site_chain`).
4. **Commits and PRs.** Nothing unpassed by `cargo test --workspace --locked` on a fresh database is
   pushed. Push only to your designated branch and open a draft PR; the owner merges. Bundle related
   work in one PR. Keep docs concise: long docs and comments swell every later session's context.
5. **Documents win, and they are the lead's.** Builders report where a design was wrong; the lead
   writes the correction in. Every label in code is a row in `docs/PHASE-2-STORAGE-DESIGN.md`
   §12.2. An applied migration is never edited (it is checksummed); corrections go in the next
   migration's header.
6. **Never from memory.** A security fact is looked up and cited with a date, or written as "could
   not establish". The four forbidden sentences in `CLAUDE.md` apply to every user-facing string.
7. **Local PostgreSQL** is the packaged cluster (`/var/lib/postgresql/16/main`,
   `127.0.0.1:5432`). If it is down, start that one (`pg_ctlcluster 16 main start`), never a
   second. A fresh container may lack the roles: provision them as CI does
   (`.github/workflows/ci.yml`, "Provision a non-superuser test role"). Client engine tests need
   `bash scripts/build-wasm.sh` first. `api.osv.dev` is blocked here; `scripts/osv-gate.sh` fails
   closed and runs in CI.

---

## Decisions an executing session must not reopen

Each binds until overruled on merit in writing (`CLAUDE.md` rule 6):

- Master key is a file, provider `file://`/`command://`/`env://`; vault takes two secrets —
  ADR-0043.
- Engines are signed data packs, never code — ADR-0044.
- ChaCha20-Poly1305 with random nonces and mandatory per-design keys; HMAC-SHA-256 chain MAC;
  HKDF-Expand subkeys — storage §12.3, §12.4.
- The seal covers metadata as stored plus a keyed binding — storage §11.2.
- Re-wrap is deployment-wide in one transaction — storage §12.6.
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
- The building view (ADR-0046 §4) is a zoom level, not a parked idea.
