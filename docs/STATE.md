# What is actually built

**Last confirmed:** 2026-09-12. Read numbers off a real run, not off this page.

This page records what exists. It is not a changelog — history lives in `docs/archive/`.

---

## Working and keeping

**The Rust engine.** Schema toolchain, typed graph store, config ingest with the redaction gate,
the fragment-to-store weld, the finder, emitters, layout. 985 tests passing as of 2026-09-12. Zero external
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
is a constraint rather than a policy. The operator database role has `SELECT` on five tables and
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

## Being replaced

**The browser client.** Currently a single large HTML file assembled by Rust. Four views work
(diagram, inventory, finder, findings); two were never built (walkthrough, config). The gestures
are proven — placing boxes, drawing links, cabling, drag-to-connect — each with browser tests
behind it. **The interaction design is worth keeping; the implementation is not.**

**The layout engine.** Works, and is cubic — 36,481 nodes took 244 seconds when measured. Being
replaced with a standard algorithm.

---

## Never built

- Walkthrough view — the teaching half of the product.
- Config view.
- Engine manager — how equipment types are registered and kept current.
- Automatic correlation across separately-pasted configs.
- Anything that discovers a network live. Everything today comes from pasted text.

---

## Known limits worth remembering

**The compose stack has not been started end to end.** `deploy/compose.yaml` and
`deploy/init-db/10-app-role.sh` were verified by mechanism on 2026-09-12 — the exact SQL was run
against a real PostgreSQL 16, the resulting role and database were confirmed to let the server
migrate and serve, and `docker compose config` renders correctly — but the pinned image could not be
pulled in this environment (registry egress blocked). **Run `docker compose up` from a clean checkout
somewhere with registry access before calling deployment proven.**

**The server refuses to start on a broken schema, deliberately.** `EngineState::load` runs every
gate and will not serve a vocabulary that fails one. Before 2026-09-12 it started anyway, reported
healthy, and served an empty kind list — an independent check reproduced that against a live
database. A broken tree is now a startup failure naming the gate and the file, exit 7.

`deploy/Dockerfile` copies `schema/` into the distroless runtime stage from the build stage, so the
image ships exactly the tree it was built against. `FATHOM_SCHEMA_ROOT` overrides the path. Both
landed 2026-09-12 after the same check found the image crash-looped with no schema beside the binary
and no way for an operator to point it elsewhere.

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
