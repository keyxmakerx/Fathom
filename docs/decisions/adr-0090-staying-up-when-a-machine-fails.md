# ADR-0090: Staying up when a machine fails — high availability

**Status:** proposed 2026-11-02, design only. Waiting on sign-off card r89-scale-and-ha (questions 5
and 6). Each "Recommended" is the pick pre-selected on that card; nothing here is built.

**Builds on:** ADR-0063 (live co-editing over PostgreSQL `NOTIFY`), `docs/RUNNING-IT.md` "Running
more than one server", ADR-0070 (backups), ADR-0089 (site readers).
**Keeps:** one writable PostgreSQL as the single source of truth; every key-handling rule in
`docs/OPERATING.md`.

## 1. What the owner asked

> even though we have loadbearing i don't think we have HA which we also need to account for.

(Key Maker, 2026-11-02.)

## 2. What exists today (read from main at d8f246d, 2026-11-02)

The owner is half right. **Several Fathom servers behind a load balancer already work**, and that
is most of what high availability needs on the server side:

- Sessions, single-use nonces and sign-in limits are database rows; live changes, presence and
  pointers cross servers through PostgreSQL `NOTIFY` (`crates/fathom-server/src/live.rs`). No sticky
  sessions are needed.
- Migrations take an advisory lock, so servers starting together take turns (`migrate.rs`).
- The audit feed is shipped by whichever server holds its advisory lock; another takes over within
  five seconds (`audit.rs`, `SHIPPER_LOCK_KEY`).
- `/health` runs a real query under a timeout and answers 503 when the database cannot be reached
  (`health.rs`), so a load balancer stops sending people to a server that cannot serve.
- The console placement snapshot re-reads every five seconds, so several processes agree
  (`placement.rs`).

What is **not** highly available today:

1. **The database.** `compose.yaml` runs one PostgreSQL. `docs/RUNNING-IT.md` tells an operator to
   bring a managed PostgreSQL with failover, or Patroni, but Fathom ships no such setup and no test
   proves Fathom survives a failover.
2. **The shipped stack is one host.** `docker compose up --scale server=2` protects against a
   crashed process, not a dead machine (`docs/RUNNING-IT.md` says so).
3. **Firmware images** live in a folder (`FATHOM_FIRMWARE_DIR`) that every server must share; on
   several hosts that means a network share the operator builds.
4. **Upgrades stop the service.** Nothing states that a migration must keep the previous release
   working, so a rolling upgrade (one server at a time) is not safe to promise.
5. **Device reading** (ADR-0082, ADR-0089) will add a job queue and readers; they need the same
   treatment from the start.

## 3. Facts this rests on

Read on 2026-11-02 from the sources named, not from memory (CLAUDE.md rule 1).

| Fact | Source |
|---|---|
| With `synchronous_standby_names` set and `synchronous_commit = on`, a commit waits until the synchronous standbys report they have received the commit record and flushed it to durable storage, so a committed transaction is lost only if the primary and every synchronous standby lose their storage. `remote_apply` additionally waits until it is visible to queries on the standby. With `synchronous_standby_names` empty, those settings only wait for the local flush. | PostgreSQL documentation, `synchronous_commit` (version 17 text), via postgresqlco.nf |
| Patroni's `synchronous_mode` *"makes sure that successfully committed transactions will not be lost at failover"*, *"at the cost of losing availability for writes when Patroni cannot ensure transaction durability"*; `synchronous_mode_strict` keeps that guarantee when no synchronous standby is available by *"blocking all client writes to the primary"*. | Patroni documentation (readthedocs, master) |
| PgBouncer must use session pooling in front of Fathom: `LISTEN` and the advisory locks live on a connection. | `docs/RUNNING-IT.md`, "Running more than one server" |

**Could not establish here:** how long a real failover takes end to end with Fathom on top (database
promotion plus every server's reconnect plus every live stream's re-read). §5's test measures it.
This record quotes no figure for it.

## 4. Decided (recommended picks)

### 4.1 The target, in plain words

**Any one machine can fail, the database's included, and people keep working after a short pause,
with no saved change lost.** Concretely: a person mid-edit sees the live banner for a moment, then
carries on; nothing they saved before the failure is gone; nobody signs in again. The pause is
measured by §5, not promised here.

Out of scope: losing a whole datacenter or region. That is recovery from backups (ADR-0070) at a
second place, not high availability, and gets its own record if wanted.

### 4.2 How much a database failure may lose (card question 5)

**Recommended (A): nothing that was saved.** The database runs on three machines. Every save waits
until a second machine has it on disk before Fathom says "saved" (§3: synchronous replication). If
the main database machine dies, a copy that already has every save takes over. The cost is a little
time on every save (one network round trip inside the site), and three database machines rather
than two, so that losing any one never stops saves: with two, a dead copy would either stop every
save (strict) or quietly drop back to the risk B accepts.

**(B) Up to a few seconds of saves.** Copies follow behind without the main machine waiting.
Faster saves, two machines are enough, and a failover can lose whatever had not reached the copy.
For a record of an estate, where a lost cable change is found weeks later on the floor, that is the
wrong trade.

### 4.3 How Fathom delivers it (card question 6)

**Recommended (A): support any highly available PostgreSQL, ship one tested reference setup, and
prove failover in CI.**

- **Support:** Fathom works with any PostgreSQL that keeps one writable primary behind one address
  and fails over by itself: a managed service, Patroni, or a Kubernetes operator. Fathom never reads
  from a copy (replicas are standbys only, as today), which keeps every read consistent with what
  was just saved.
- **Reference setup:** `deploy/ha/` holds a three-host setup: three PostgreSQL machines run by
  Patroni with synchronous mode (A of §4.2), its coordination store on the same three hosts, a
  floating address or HAProxy in front, two or more Fathom servers, one backup service. Every image
  pinned by digest, as `compose.yaml` does. `docs/RUNNING-IT.md` walks through it.
- **Proof:** a CI job brings the reference setup up on one runner, keeps an editor saving and a
  live stream open, kills the database primary, then kills a Fathom server, and checks that no
  saved change is missing, the stream recovered, and nobody was signed out. The pause it measured is
  written to `docs/SCALE.md` with the date.

Rejected: (B) building database failover into Fathom's own Compose file as the default; most
operators who need high availability already run PostgreSQL somewhere with failover, and a home lab
does not need three database machines. (C) Documentation only; that is today, and it proves
nothing.

### 4.4 The smaller gaps, closed without a question

- **Firmware images move into the database's reach.** Store staged images either in PostgreSQL
  (large objects, encrypted like everything else, fine at the sizes `FATHOM_FIRMWARE_MAX_BYTES`
  allows) or in an S3-compatible store; a shared folder stays supported. Whichever the firmware
  thread finds simpler, decided there with measurements.
- **Upgrades one server at a time.** A rule for every migration from here on: a release's
  migration must leave the previous release working (add first, remove in a later release; never
  rename in one step). CI checks it by running the previous release's test suite against the new
  schema. Then an operator upgrades one server, then the next, with no stop.
- **Readiness, not only health.** `/health` stays as is. A server that is draining for an upgrade
  answers `/ready` with 503 so the load balancer stops sending new people while live streams finish
  or move.
- **One of each background job.** Every job that must run once across all servers (scheduled
  reads' planner, ADR-0089 §4.6; the audit shipper; any future sweep) takes a PostgreSQL advisory
  lock as the audit shipper does, and hands over within seconds if its server stops.
- **The device-reading queue** (ADR-0089 §4.7) is a table with leases, so any server can hand out
  jobs and a dead server or reader returns its jobs to the queue.
- **Keys on every host.** Already documented (`docs/OPERATING.md`, "The key file"); the reference
  setup reads them through `command://` from a secret manager, so no key file is copied by hand.

### 4.5 What stays per server, on purpose

The cache of open designs (rebuilt from the database on first use) and the live limits per server
(`docs/RUNNING-IT.md`). Losing a server loses its cache, which costs one rebuild per design.

## 5. Built in this order

1. The migration rule, its CI check, and `/ready`.
2. Firmware images off the shared folder.
3. `deploy/ha/` and the failover test in CI.
4. The reader queue's leases (with ADR-0089 step 1).

## Not decided here

- A second site or region (disaster recovery beyond backups).
- Running Fathom on Kubernetes as a supported target (a Helm chart). The reference setup is plain
  hosts; a chart can follow if a customer asks.
- The exact Patroni coordination store and load balancer; chosen in the reference setup's PR with
  pinned digests and a dependency note.
