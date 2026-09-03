# WO-11 — The server skeleton, and the gate that survives 109 crates

> **Status: OPEN.** No dependencies. **This is the first server-side work order and phase 1's
> first row.** Phase 0 completed 2026-09-03 when ADR-0040 closed `49` §22's decision 1; the
> owner said *"start working on the server version"* the same day.
>
> **It carries ONE owner act that cannot be delegated and must happen before any code lands —
> §5 step 0.** Read it first. If it has not happened, this order is BLOCKED on the owner and a
> session must not begin.

## 0. Contents

| § | |
|---|---|
| 1 | Objective |
| 2 | Binding sources |
| 3 | Prior state |
| 4 | Deliverables |
| 5 | The plan |
| 6 | Acceptance gates |
| 7 | Stop-and-escalate triggers |
| 8 | Non-goals |
| — | Failure modes · Open decisions · Sources consulted · Disagreements |

## 1. Objective

**A `fathom-server` binary that starts, answers a health check, and talks to PostgreSQL — and a
dependency gate that is still a real control on the other side of it.**

That second half is the objective. The first half is ordinary work.

Fathom has **zero external dependencies today**: `Cargo.lock` holds 16 packages, all
first-party. A working server is roughly **109 crates** before Fathom's own cryptography
(`49` §6.1). `49` §20 states the cost in one line and it is the reason this order exists and is
first:

> *"Zero external dependencies becomes about 109 crates … in the same month a build-script
> supply-chain attack against crates.io was published. **That is the project's greatest current
> security advantage, and it is about to be spent. Spend it deliberately.**"*

`76` §7.1's principle is *"retire the cheapest expensive risk first"*. The expensive risk here
is not that the server fails to start; it is that 109 crates arrive with nobody looking, once,
irreversibly. So this order deliberately builds **the smallest server that proves the stack
works** and spends its real effort on the gate.

## 2. Binding sources

| source | what it binds here |
|---|---|
| **ADR-0040** (2026-09-03) | the server holds keys and says so; §7 of this order forbids storing anything until the key boundary exists, so this order stores nothing |
| **ADR-0032** §5, §6 | a `deps/decisions/<crate>.md` per external package, and **approval is an owner act that may not be delegated** |
| **ADR-0034** §4 | the mechanical vulnerability scan lands **before** the first dependency — `49` §6.1 calls it *"overdue rather than early"* |
| `49` §5 | architecture — the server thinks, the browser looks |
| `49` §6 | every crate and version, read from crates.io 2026-08-21 — **re-read them, see §7 trigger 1** |
| `49` §6.1 | the gate, the caps, and the arrayref attack |
| `43` §5.4 | the compose file: pinned digest, read-only filesystem, non-root, all capabilities dropped, no-new-privileges, the binary as its own healthcheck |
| `35` §5.1 | the caps: **≤30 direct, ≤160 in the closure** |
| `deps/decisions/00-CLOSURE.md` | the precedent this order generalises — one closure document plus individual records |
| `78` | the execution protocol governing this order |

## 3. Prior state

Verified 2026-09-03 against the tree:

- `Cargo.lock`: **16 packages, all first-party.** `./scripts/gate-zero.sh` reports OK because
  the set it must recognise is empty.
- `deps/decisions/` holds **four files**: `00-INDEX.md`, `00-CLOSURE.md`, `argon2.md`,
  `chacha20poly1305.md`. The two crate records are **owner-approved (2026-08-15) and neither
  crate is vendored** — approval and arrival are already separate events in this project, which
  is the fact §5 step 0 leans on.
- `00-CLOSURE.md` covers **twenty-two** crates in one document, with individual records for only
  the two direct dependencies. **This is the pattern that must scale, and gate-zero does not
  know about it** — see Disagreements 1.
- No `fathom-server` crate exists. No HTTP, no database, no async runtime anywhere in the tree.
- `cargo audit` is **not** in CI. `.github/workflows/ci.yml` runs fmt, clippy, test,
  schema-check and gate-zero.
- 744 tests, zero external dependencies, `fathom-wasm` module at 988,540 bytes.

## 4. Deliverables

1. **`scripts/gate-zero.sh` taught the closure pattern** — a crate satisfies the gate if it has
   its own record **or** is listed in an approved closure document. Individual records stay
   required for every **direct** dependency. §5 step 1.
2. **`deps/decisions/00-CLOSURE-SERVER.md`** — the measured closure for this order's
   dependencies, one row per crate: name, version, publisher, licence, whether it ships or is
   build/test-only, whether it has a `build.rs` or is a proc-macro, and its advisory status.
   Generated from `cargo tree` and `cargo audit` output, **not** typed from memory.
3. **Individual records** in `deps/decisions/` for every direct dependency this order adds.
4. **`cargo audit` in CI**, and a `deny` on any advisory, satisfying ADR-0034 §4.
5. **`crates/fathom-server`** — an axum binary with: a `/health` endpoint that answers only
   after a real round trip to PostgreSQL; structured logging via `tracing`; graceful shutdown;
   configuration from the environment with no secret ever logged.
6. **Migration machinery plus migration `0001`**, which creates only the migrations table
   itself. **No tenant table, no graph tables, no user table** — see §8.
7. **A compose file** per `43` §5.4, with Caddy terminating TLS in front and PostgreSQL on a
   loopback or Unix socket so C7 survives (`49` §6).
8. **Tests**: the server starts and stops cleanly; `/health` fails honestly when the database is
   unreachable rather than reporting healthy; no configuration value containing a secret appears
   in any log line at any level.

## 5. The plan

**Step 0 — THE OWNER ACT, BEFORE ANY CODE. This step is not a session's to perform.**

ADR-0032 §5 makes crate approval an owner act that may not be delegated. This order needs the
owner to approve, in one sitting and in writing:

- **the closure-document pattern** as satisfying that requirement for transitive crates
  (Disagreements 1 explains why 109 individual records is a worse control, not a better one);
- **the direct dependency list** from `49` §6's table, each of which gets its own record.

A session that finds no such approval recorded **stops here and reports it**. It does not
approve on the owner's behalf, and it does not start with "just the skeleton" — the skeleton is
what brings the crates.

**Step 1 — the gate first, while the lockfile is still clean.**

Extend `scripts/gate-zero.sh` before adding a single crate, so the gate is written against an
empty set and cannot be shaped to fit what already arrived. Add its own test: a fixture lockfile
with an unapproved crate must fail, and one whose crate appears only in a closure document must
pass. **Write the failing case first and watch it fail.**

**Step 2 — `cargo audit` in CI, still with zero dependencies**, so its first real run is the one
that admits the 109 and not a run six weeks later.

**Step 3 — the crate, one dependency at a time, in this order:** `tokio`, then `axum`, then
`tracing`, then `tokio-postgres` with `deadpool-postgres`. After **each** one: re-run
`cargo tree`, update the closure document, run gate-zero and `cargo audit`, and commit. Four
commits, four green gates. **Do not add all four and reconcile afterwards** — the point is that
the gate is exercised on every arrival.

**Step 4 — the health endpoint, and make it honest.** It must perform a real query. A health
check that reports healthy while the database is down is worse than none: it is the paste hint
that said `REPLACES` (`49` §19's lesson (d)) in operational clothing.

**Step 5 — migrations, and one migration that creates only the migrations table.** Resist
adding the tenant table here; it belongs with the key boundary, and the key boundary needs a
decision this order does not have (§7 trigger 2).

**Step 6 — the compose file**, and run it: bring the stack up, curl the health endpoint through
Caddy over TLS, kill PostgreSQL, confirm health reports unhealthy, bring it back.

**Step 7 — the floor, plus the two new gates**, and record the closure's real size against
`35` §5.1's caps.

## 6. Acceptance gates

* **G1 — the floor** (`78` §6) green: fmt, clippy, `cargo test --workspace --locked`,
  `fathom-schema-check` 0/0, gate-zero, and the wasm build. **The wasm module's size must be
  unchanged** — nothing in this order touches the client, and a change there means something
  leaked across the boundary.
* **G2 — gate-zero is a real control, proved by making it fail.** Add a crate to a fixture
  lockfile with no record and no closure entry; the gate must fail by name. Remove it; the gate
  must pass. **A gate nobody has watched fail is not known to work** — CLAUDE.md rule 0's
  discipline applied to a build gate.
* **G3 — `cargo audit` runs in CI and fails the build on any advisory.** Prove it the same way:
  a run against a pinned advisory-bearing version fails, then is removed.
* **G4 — every external package in `Cargo.lock` is either individually recorded or listed in an
  approved closure document, and the closure document's contents were generated from tooling
  output.** State the measured closure size against `35` §5.1's ≤160, and the direct count
  against ≤30.
* **G5 — `/health` answers only after a real database round trip**, and reports unhealthy when
  PostgreSQL is stopped. Driven against the running compose stack, not mocked.
* **G6 — no secret reaches a log.** A test sets a configuration value containing a recognisable
  token and asserts it appears in no log line at any level, including on the error paths.
* **G7 — the stack comes up from the compose file on a clean machine** and the health endpoint
  answers through Caddy over TLS. Record the command sequence that did it.
* **G8 — nothing is stored.** `grep` the migrations for any table other than the migrations
  table itself; there must be none. This order writes no customer data, so ADR-0040's key
  boundary is not yet required — and that is why it may not store anything.

## 7. Stop-and-escalate triggers

1. **Any version in `49` §6's table has moved, been yanked, or acquired an advisory.** Those
   versions were read on 2026-08-21. **Re-read every one from crates.io and from the RustSec
   database before pinning it**, name the source and the date (ADR-0034), and escalate rather
   than substituting a version on your own judgement. A yanked crate in this list is a planning
   decision, not an execution one.
2. **Anything in this order turns out to require storing customer data.** ADR-0040 D1 requires a
   data key per tenant and per design from the first stored byte, and ADR-0040 §9 items 1 and 2
   leave the key-management service **undecided** — including for self-hosted deployments with
   no cloud KMS. Storing a row before that is decided is the retrofit ADR-0040 exists to
   prevent. Stop.
3. **The closure exceeds `35` §5.1's caps** — more than 30 direct or more than 160 in the
   closure. Do not trim by removing a security control. Escalate the number.
4. **`rustls` appears in the shipped closure.** `49` §6 keeps C7 — no C or C++ in the shipped
   closure — only if TLS is terminated **in front of** the binary. `49` §21 item 21 records that
   dependency resolution differed between two scratch builds on exactly this question.
   **Resolve it on the real manifest, and if `rustls`'s crypto provider is in the closure,
   stop** — C7 is a decision, not a detail.
5. **`cargo audit` reports an advisory with no patched version available.** Escalate; do not
   accept it silently or add an ignore entry.
6. **A crate arrives that the owner did not approve in step 0** — including one pulled in
   transitively that the closure measurement missed. Stop, add it to the closure document, and
   get it approved before continuing.

## 8. Non-goals

This order deliberately does **not** build:

- **Accounts, sessions, passwords, passkeys, sign-in, or anything a user can log into.** That is
  the next order, and it needs the key boundary.
- **Any graph table, tenant table, or user table.** G8 forbids them.
- **Row-level security or the cross-tenant test** (`49` §11) — they need tables.
- **The HTTP API, WebSockets, or any opcode.** `/health` is the only endpoint.
- **The key-management service.** Undecided; ADR-0040 §9 items 1 and 2.
- **Anything client-side.** The wasm module and the page are untouched, and G1 proves it.
- **`fathom-artifact`'s retirement.** `49` §18 retires it eventually; nothing here depends on
  that and removing it would break every existing browser driver.

## Failure modes

| failure | what stops it |
|---|---|
| 109 crates arrive and the gate is quietly widened to let them | step 1 writes the gate **before** the first crate, and G2 proves it fails |
| the closure document is typed from memory and is wrong | G4 requires it generated from `cargo tree` and `cargo audit` output |
| `cargo audit` is added but never fails, so nobody knows it works | G3's positive control |
| health reports healthy while the database is down | G5, driven against a stopped database |
| a database URL with a password lands in a log | G6 |
| C7 is lost to `rustls` without anyone deciding | trigger 4 |
| the tenant table lands here and the key boundary is retrofitted later | G8 and trigger 2 |
| a version from a table read on 2026-08-21 is pinned unread | trigger 1 |

## Open decisions

None blocking this order **except step 0's owner act**, which is a precondition rather than an
open question. Recorded here because the next order needs them:

1. **Which key-management service** (ADR-0040 §9 item 1). Blocks the first stored row.
2. **The self-hosted key story** — no cloud KMS on a customer's own hardware (ADR-0040 §9
   item 2). Blocks the self-hosted build.
3. **Whether the audit log is phase 1 or phase 2** (ADR-0040 §9 item 4).

## Sources consulted

| source | for |
|---|---|
| `docs/90-decisions/adr-0040-*.md` | the custody decision this order must not front-run |
| `docs/90-decisions/adr-0032-*.md` §5, §6 | crate approval as an undelegatable owner act |
| `docs/40-stack/49-the-server-product.md` §5, §6, §6.1, §20 | architecture, crates, the gate, the cost |
| `docs/40-stack/43-deployment-modes.md` §5.4 | the compose file and the healthcheck |
| `deps/decisions/00-CLOSURE.md` | the twenty-two-crate precedent this order generalises |
| `scripts/gate-zero.sh` | read in full 2026-09-03; it demands a record per package with no closure provision |
| RustSec advisory for the arrayref supply-chain attack (2026-08-20), as recorded in `49` §6.1 | why the gate is the objective |

## Disagreements

1. **With gate-zero as written, and with the literal reading of ADR-0032 §6.** The gate demands
   `deps/decisions/<crate>.md` for **every** package in the lockfile, and ADR-0032 §5 makes each
   one an owner act that may not be delegated. At 109 crates that is 109 owner approvals — and
   **it would make the control weaker, not stronger**, because the only way a solo maintainer
   completes it is by skimming, and a rubber stamp on 109 files is indistinguishable from no
   review while looking like thorough review. `deps/decisions/00-CLOSURE.md` already established
   the better shape on 2026-08-15: **one closure document covering twenty-two crates, with
   individual records for the two direct dependencies.** This order generalises that pattern and
   teaches the gate about it. What it preserves: an individual, reasoned record for every crate
   Fathom **chooses**, and a single approved document naming every crate that arrives because of
   those choices — with its publisher, licence and `build.rs` status, which is the data the
   arrayref attack was actually about. What it gives up: the fiction that 109 individual
   approvals would have been read.
2. **With `49` §19's placement of "operational logging" late in phase 1.** `tracing` arrives with
   the skeleton because retrofitting structured logging means rewriting every call site. It is a
   deliverable here, not a phase-1 tail item.
