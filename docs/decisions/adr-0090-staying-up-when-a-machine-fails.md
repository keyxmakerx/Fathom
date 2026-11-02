# ADR-0090: Staying up when a machine fails — high availability

**Status:** proposed 2026-11-02, design only. On card r89-scale-and-ha the owner approved every
pick and asked, in a note, for high availability built in, set up like their Palo Alto firewall
pairs (§4.2). §4.3 and §4.4 are reworked after that note and go back to the owner as r89 version 2.
Each "Recommended" is the pick pre-selected there; nothing here is built.

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
| Non-strict `synchronous_mode`: *"When no suitable standby is available, primary server will still accept writes, but does not guarantee their replication."* Under it, *"A node that is not the leader or current synchronous standby is not allowed to promote itself automatically."* | Patroni documentation, "Replication modes" (readthedocs, latest) |
| An etcd cluster *"operates so long as a member quorum can be established"*; three members tolerate one failure, two members tolerate none, and an odd number is recommended. | etcd v3.5 FAQ |
| VRRP: *"The scope of each virtual router is restricted to a single LAN."* | RFC 5798 (March 2010, Proposed Standard), obsoleted by RFC 9568; the scope line read from RFC 5798 |
| PgBouncer must use session pooling in front of Fathom: `LISTEN` and the advisory locks live on a connection. | `docs/RUNNING-IT.md`, "Running more than one server" |

**Could not establish here:** how long a real failover takes end to end with Fathom on top (database
promotion plus every server's reconnect plus every live stream's re-read). §4.4's test measures it.
This record quotes no figure for it.

## 4. Decided (recommended picks)

### 4.1 The target, in plain words

**Any one machine can fail, the database's included, and people keep working after a short pause,
with no saved change lost.** Concretely: a person mid-edit sees the live banner for a moment, then
carries on; nothing they saved before the failure is gone; nobody signs in again. The pause is
measured by §5, not promised here.

Out of scope: losing a whole datacenter or region. That is recovery from backups (ADR-0070) at a
second place, not high availability, and gets its own record if wanted.

### 4.2 The owner's question: a pair, like the Palo Altos?

The owner's note on r89 (2026-11-02), which approved every pick and asked for this to be thought
through again:

> Can't we build HA into our app natively? But how would that work with loadbalancing? will we have
> to have 2 Loadbalanced, with database syncing, and then a HA behind both? hmm... think on this
> more because idk. I'm thinking of how our paloalto's are setup.

A firewall HA pair has three parts: a **floating address** that moves to whichever unit is active,
a **heartbeat** so each unit knows the other is alive, and **state sync** so the passive unit
already has the active unit's state when it takes over. Fathom has three layers, and they map onto
that like this:

| Layer | What it holds | How it stays up | Firewall-pair equivalent |
|---|---|---|---|
| Front door | nothing | one floating address (VRRP), or the operator's own load balancer | the floating IP |
| Fathom servers | nothing a request needs (§2) | all of them active; any one can serve anyone | better than a pair: both units are active and need no sync |
| Database | everything | one active, one copy kept in step on every save | session sync on the data link |

So no: it is not "two load balanced, with database syncing, and an HA behind both". It is one
floating address in front, Fathom servers that are all active because they keep nothing, and a
database that is an active/passive pair with sync. Only the database needs the firewall-pair
treatment, because only the database holds state.

**Where it differs from a firewall pair: the tie-breaker.** Two units alone cannot tell "my peer
died" from "the link between us was cut". A firewall pair that guesses wrong has both units active
for a while, which is an outage. A database that guesses wrong has two primaries both taking saves,
and the two records then disagree forever, which for a tamper-evident chain is the worst failure
there is. So the database pair gets a **third vote**: a small tie-breaker box that holds no data and
only votes. Whichever side can still see the tie-breaker keeps going; the other stops. etcd's own
documentation gives the arithmetic: a cluster of three tolerates one failure, and a cluster of two
tolerates none (§3).

### 4.3 How much a database failure may lose (card question 5, reworked after the note)

**Recommended (A): nothing that was saved, on two database machines and a tie-breaker.** Each save
waits until the other database machine has it on disk before Fathom says "saved" (§3: synchronous
replication). If the active machine dies, the copy already has every save and takes over, and only
that copy may (Patroni: *"A node that is not the leader or current synchronous standby is not
allowed to promote itself automatically"*, §3). If the copy dies instead, the active machine carries
on alone, like a firewall running single after its peer fails; in that window a second failure
could lose saves, and Admin says so in red until the copy is back. (This is Patroni's non-strict
`synchronous_mode`, §3.)

**(B) Three full database machines.** As A, and a second failure while one machine is down still
loses nothing. One more machine with a full copy.

**(C) Copies that trail by a few seconds.** Faster saves; a switch-over can lose the last few
seconds. For a record of an estate, where a lost cable change is found weeks later on the floor,
the wrong trade.

Not offered: two machines and no tie-breaker (split brain, above).

### 4.4 How Fathom delivers it (card question 6, reworked after the note)

**Recommended (A): built in, set up like a firewall pair.** "Fathom HA" is a mode of the same
install, not a separate product:

- **Nodes.** Each of two nodes runs the same set of containers: the Fathom server, PostgreSQL, the
  failover agent and the floating-address agent. A third, small box runs only the tie-breaker.
- **Setting it up.** Install node 1 as today. Admin › High availability › **Add a node** shows a
  join code; node 2 and the tie-breaker are started with it, copy the database and the keys over an
  encrypted link (the key handling of `docs/OPERATING.md` applies: the keys never pass through the
  browser), and appear on the page once in step.
- **The floating address follows the database.** The node whose database is active holds the
  address, so people and that node's Fathom server talk to the active database on the same box.
  VRRP works within one network segment (§3), as a firewall pair's floating IP does; nodes in two
  different segments or sites use the operator's load balancer instead.
- **Load balancing is optional.** With the floating address alone, one node serves everyone and the
  other is warm. For more capacity, or nodes in different segments, point a load balancer at every
  node's Fathom server: any of them serves anyone (§2), and they all reach the active database.
- **Admin › High availability** shows which node is active, whether the copy is in step, the
  tie-breaker's vote, and the last switch-over with its reason. **Switch over now** moves the active
  role for maintenance, as a firewall pair's "suspend" does. Every switch-over is sealed on the site
  chain.
- **Underneath, proven parts, not new ones.** PostgreSQL's own replication, and Patroni for the
  heartbeat, the vote and promotion. Fathom configures, watches and explains them; it does not
  re-implement them (rejected C below).
- **Bring your own still works.** An operator with a managed PostgreSQL or their own Patroni points
  Fathom at it as `docs/RUNNING-IT.md` says today, and skips the built-in mode.
- **Proof.** A CI job brings up two nodes and a tie-breaker on one runner, keeps an editor saving and
  a live stream open, kills the active node, cuts the link between the nodes, and kills a Fathom
  server, and checks after each that no saved change is missing, only one database ever took saves,
  the stream recovered and nobody was signed out. The pause it measured goes in `docs/SCALE.md`.

**(B) Bring your own HA database only**, with a tested reference setup in `deploy/ha/`. This was the
first recommendation. It suits operators who already run PostgreSQL with failover, and B's users
are still served by A's last two bullets, so A loses nothing B had.

**(C) Fathom's own failover code**, with Fathom's server electing a leader and moving the database
itself. Rejected: deciding which machine is in charge during a network fault is the hardest
problem in this record, a bug in it is the split brain of §4.2, and PostgreSQL and Patroni already
solve it with years of production use. Building it ourselves buys nothing a person would see.

**A home lab** stays one box, as today. Nothing here is required.

### 4.5 The smaller gaps, closed without a question

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

### 4.6 What stays per server, on purpose

The cache of open designs (rebuilt from the database on first use) and the live limits per server
(`docs/RUNNING-IT.md`). Losing a server loses its cache, which costs one rebuild per design.

## 5. Built in this order

1. The migration rule, its CI check, and `/ready`.
2. Firmware images off the shared folder.
3. Fathom HA (§4.4): two nodes and a tie-breaker, the join code, the floating address, Admin › High
   availability, and the failover test in CI. Its new images (Patroni, etcd, a VRRP agent) come to
   the owner on a card first, with a dependency note, as the reader's packages did.
4. The reader queue's leases (with ADR-0089 step 1).

## Not decided here

- A second site or region (disaster recovery beyond backups).
- Running Fathom on Kubernetes as a supported target (a Helm chart). The reference setup is plain
  hosts; a chart can follow if a customer asks.
- The exact images for the failover agent, its coordination store and the floating address; chosen
  in the build PR with pinned digests and a dependency note.
- Whether the tie-breaker may run on something the operator already has (a small VM, a NAS) rather
  than its own box; measured in the build.
