# ADR-0089: Site readers — device reading at estate scale

**Status:** proposed 2026-11-02, design only. Waiting on sign-off card r88-scale-and-ha. Each
"Recommended" below is the pick pre-selected on that card; nothing here is built.

**Builds on:** ADR-0082 (Fathom reads devices and never writes to them; the separate reader helper,
§4.3), ADR-0079 (one estate across designs: the estate index, a design per site), ADR-0071 (the
vault, Mode B `use_login`), ADR-0042 (credentials only where a person chose to store them).
**Keeps, unchanged:** ADR-0082 §2's amended invariant 2 (read, never write, never act), CLAUDE.md
rule 4 (a fetched config's credentials never arrive), invariant 1 (no connection the operator did
not configure), and the reader's packages as approved on r87-reader-packages.
**Companion:** ADR-0090 (staying up when a machine fails), which covers the server and database side.

## 1. What the owner asked

> as long as it is super secure, and can monitor upwards of 100k devices then we are good.... which
> saying that we may need to have agent dockers won't we...?

(Key Maker, 2026-11-02, in the "Plan for 100k devices and high availability" thread.)

Two asks: **reach** (a reader that can get to devices at many sites, behind their own firewalls)
and **volume** (100,000 devices or more, read on a schedule rather than one press at a time).

## 2. What exists today

- ADR-0082 §4.3 puts every device connection in one **reader helper** beside the server, reached
  over a Unix socket. It is being built now (the "Build device reading" thread, PR 2).
- That thread has agreed, at no cost, to build the reader so it can move off the server box later:
  jobs and results are versioned, self-contained JSON behind one transport trait; the login rides
  in its own envelope inside the job and is wiped after; the reader runs the redaction gate and
  re-checks the address against the ranges it is given; each result names the reader that produced
  it (`"local"` today); the one-connection-per-device lock is a database row (PR 3); the reader caps
  its own device connections.
- Reads are by hand only. ADR-0082 §4.6 allows a schedule per design but leaves it to its own card.
- The estate is many designs (ADR-0079): `docs/SCALE.md` measures one design at about 4,000 of the
  benchmark's simple devices, a few hundred of real gear, so 100,000 devices is hundreds of designs
  joined by the estate index. That part is the record's scale, not the reader's, and is out of this
  record's scope except where §6 measures it.

One reader beside the server cannot do the job at 100,000 devices for a reason that is not speed:
**it cannot reach them.** Management networks at remote sites sit behind their own firewalls and
NAT, and opening SNMP (161) and SSH (22) from a central server to every site is exactly the kind of
hole a security team refuses.

## 3. Facts this rests on

Read on 2026-11-02 from the sources named, not from memory (CLAUDE.md rule 1).

| Fact | Source |
|---|---|
| HPKE is *"a scheme for hybrid public key encryption"* combining an asymmetric KEM, a KDF and an AEAD, with authenticated variants. It is an Informational RFC from the IRTF's CFRG, *"not an Internet Standards Track specification"*. | RFC 9180 (February 2022), Abstract and Status |
| SNMPv3 authPriv only; MD5 and DES refused; v1 and v2c not offered. | ADR-0082 §3 and §4.5 (sources there) |

**Could not establish here, and must be before build:** the throughput of one reader (devices read
per minute) and therefore how many readers 100,000 devices needs. §6 says how it is measured. This
record quotes no number for it.

## 4. Decided (recommended picks)

### 4.1 One reader, two places to run it (card question 2, A)

The reader the device-reading thread is building **is** the site reader. The same image runs in
one of two ways:

- **Beside the server** (today's default): over the Unix socket, named `local`.
- **At a site**, as one small container a Steward places on a machine that can reach that site's
  management network. It **calls home**: it opens an outbound TLS connection to the Fathom server
  and asks for work. The server never connects to it, and the site opens no inbound port.

Rejected: (B) a reader beside the server only, which cannot reach sites behind firewalls without
opening SNMP and SSH across the WAN; (C) site readers the server connects into, which needs an
inbound hole at every site and puts the server's address book of every site in one place an
attacker would want.

### 4.2 How a site reader joins, and how it proves who it is (card question 4)

1. A Steward opens Steward › Device reading › Readers › **Add a reader**, names it and picks which
   management ranges (ADR-0082 §4.4) it serves. Fathom shows a **join code**, single use, valid
   for one hour.
2. On first start the reader makes its own key pair. The private key never leaves the reader's
   volume. It sends the public key and the join code; the server stores the public key and shows
   its fingerprint to the Steward, who compares it with the one the reader prints in its log.
3. **A second admin approves** the new reader before it gets any work (recommended tick, the same
   two-person rule the vault uses for a shared login). Until then it is listed as waiting.
4. From then on every connection is mutual TLS: the reader presents a certificate for its key, the
   server presents its own, and each side refuses a key it does not expect. The reader pins the
   server's key on join, so a stolen join code used against a fake server gains nothing.
5. **Remove** on the Steward page revokes the key at once; the reader's next request is refused and
   it wipes any job it holds. Each join, approval and removal is sealed on the organisation's chain.

A reader belongs to **one organisation**. Two organisations sharing a site run two readers.

### 4.3 Where the device logins live (card question 3)

**Recommended (A): in Fathom's vault, sent per job, sealed to that one reader.** When the server
hands a reader a job, `use_login` (ADR-0071) releases the login as today, and the server seals it
to the reader's public key with HPKE (RFC 9180, §3) before it leaves the server. Only that reader
can open it, it is opened in memory for the one job, and it is wiped after, as the local reader
already does. A reader stores no logins. A stolen reader holds a key that can be revoked and no
passwords.

**Also offered (B, a per-reader setting, not built first): logins kept only at the site.** The
reader holds its own small encrypted store of logins, typed in at the site, and the job names a
login by reference. Fathom's server never holds those passwords at all. Stronger against a
compromised Fathom server; weaker on management, because each site keeps its own logins and the
vault's "used on", second-admin and audit rules apply only to what the reader reports. Built only if
a customer needs it; it gets its own card then.

What A does not protect against, said plainly: someone in full control of the Fathom server can
already release vault logins (ADR-0071), so A adds no new exposure there and removes none. B is the
answer for that threat.

### 4.4 What each side checks (the two locks)

The server only sends a reader jobs for addresses inside the ranges the Steward gave **that**
reader. The reader keeps its own copy of those ranges, received at approval and changed only by a
signed update from the server, and refuses any job outside them (agreed with the build thread, §2).
Loopback, link-local and the reader's own addresses are refused whatever is listed. The fixed OID
and command lists of ADR-0082 §4.1 live **in the reader's code**, not in the job: a job names a
purpose ("inventory", "interfaces", "lldp"), never an OID or a command string, so a compromised
server cannot make a reader send anything else.

### 4.5 What comes back

The reader runs the redaction gate (the Rust gate, compiled into the reader, as on the paste path)
before a result leaves the site. The server runs the detector again on arrival and refuses a result
that still carries a credential (rule 4, "the server refuses any that still arrive"). Every result
is signed by the reader's key and names the reader, so a result is traceable to the box that read
it. Results remain suggestions and check answers, never facts (ADR-0082 §4.2).

### 4.6 What "monitor" means here (card question 1)

**Recommended (A): keep the record true, on a schedule.** A Steward sets a schedule per design
(nightly by default, hourly the most often). Readers read every device in it and Fathom shows what
**differs from the drawing**: a new neighbour, a changed serial, a port that went down, new
firmware. Nothing is accepted into the design without a person, and nothing alerts. This is
ADR-0082 §4.6's scheduled read, which said it needs its own card: r88 is that card.

**Also offered:**

- (B) **Also a live up or down dot.** Each device's reachability polled every few minutes and shown
  on the canvas and in Inventory. Still no alerts. This is a much larger load (100,000 devices every
  five minutes is about 330 reads a second, every second) and a store of time-stamped results, so
  it waits for §6's measurement either way.
- (C) **Full monitoring with alerts.** Rejected for Fathom itself: alerting is acting on a reading,
  which ADR-0082 §2 forbids, and dedicated monitoring tools already do it. Fathom can later show a
  status read from such a tool, as its own card.

Back-of-envelope for A, not a measurement: 100,000 devices read once a night is about 1.2 device
reads a second on average across all readers; hourly is about 28 a second.

### 4.7 Two readers per site, and what happens when one dies

A Steward may give the same ranges to two readers at a site. Jobs are handed out as **leases**: a
reader takes a job for a short time (one minute, renewed while it works); if it stops renewing, the
job goes back to the queue and the other reader takes it. A device is still read by at most one
reader at a time (the database lock of §2). The queue lives in PostgreSQL, so any Fathom server can
hand out work and a server failing loses no queued job (ADR-0090).

### 4.8 Pacing, so a read never hurts a network

Per reader: a cap on devices read at once (the reader's own, §2), and per device one connection at
a time with no retry on a refused login (ADR-0082 §4.4). Per site: a Steward-set cap on reads per
second, default low. A schedule spreads its devices across its window instead of starting them all
at midnight.

## 5. What changes elsewhere

- ADR-0082 §4.3: "a separate reader helper beside the server" becomes "a reader, beside the server
  or at a site (ADR-0089)". §4.6's scheduled reads get their card here.
- Steward › Device reading gains a **Readers** list: name, ranges, last seen, version, key
  fingerprint, waiting/approved, Remove. Placed with the layout thread when built.
- `docs/RUNNING-IT.md` gains "Placing a reader at a site": one container, one environment variable
  (the server's address), one join code, outbound 443 only.
- The dependency record: the site reader adds an outbound TLS client and mutual TLS to the reader's
  workspace only. Its packages come to the owner on a card first, as r87's did. The server gains a
  TLS listener for readers; that is a new public surface and gets an attack round before it is
  merged, like Teams did (#284).

## 6. How "100,000 devices" is proved, not claimed

Before anything here is called done:

1. A **simulator** of SNMPv3 devices (authPriv, SHA-256, AES-128) answering the reader's fixed OID
   list, run in CI at a small count and on a bench at full size.
2. One reader against simulated devices: devices read per minute at the default pacing. That number
   sets how many readers 100,000 devices needs, and it goes in `docs/SCALE.md` with the date.
3. 100,000 simulated devices across many readers and two Fathom servers: the job queue, the results
   arriving and the "differs from drawing" lists, measured end to end.
4. A reader killed mid-run and a Fathom server killed mid-run (ADR-0090): no job lost, no device
   read twice at once.

The record side (hundreds of designs, the estate index at 100,000 devices) is measured in the same
run, since `docs/SCALE.md` lists the index's rebuild time as not yet measured.

## 7. Built in this order, each its own PR

1. Scheduled reads with the local reader (A of §4.6), leases and the queue in PostgreSQL.
2. The simulator and the single-reader measurement (§6.1, §6.2).
3. The site reader: join, approval, mutual TLS, sealed logins, signed results. Attack round first.
4. The full-scale run (§6.3, §6.4); numbers into `docs/SCALE.md`.

## Not decided here

- Whether B of §4.3 (logins kept at the site) or B of §4.6 (live up/down) is ever built.
- The site reader's TLS and HPKE packages: chosen with a dependency record and the owner's tick.
- Reading through a jump host or a controller API (UniFi, Omada).
- FIPS 140-3 builds (the build thread keeps the reader's crypto behind one seam so it can be added).
