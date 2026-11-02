# ADR-0089: Site readers — device reading at estate scale

**Status:** accepted 2026-11-02, design only; nothing here is built. The owner approved every pick on
sign-off card r89-scale-and-ha (§4), and every pick on r90-reading-at-a-million (§8), with a note
that changed two of them: host keys are approved both in bulk and one device at a time (§8.2 item
3), and MAC and ARP tables are read on a schedule as well as on request (§8.2 item 4). §9, the other
half of that note (Zabbix, Splunk, Calix and Nokia), was approved on r91-systems-and-cpe with every
pick, and a note that the owner runs Calix CMS and Nokia SAM, not SMx, Calix Cloud or Altiplano.
§9.6 is reworked for that; it goes ahead on its recommended pick and waits on r91 version 2.

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
ADR-0082 §4.6's scheduled read, which said it needs its own card: r89 is that card.

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

## 8. At a million devices: what this record changes (accepted on r90-reading-at-a-million)

The owner asked (2026-11-02): *"What issues could crop up from this design, is this really the best
method with the amount of traffic it would have with SNMP alone, or do we need to continue with the
agent idea ... Will it impact database lookups, because remember we will have close to 1 million
entries just starting off."* The full answer, in plain words, is the doc "Fathom at a million
devices" (https://claude.ai/artifact/YZY4qs5wMidQEHRMKxJpvo). What it changes here:

### 8.1 Site readers stay, for the network, not the volume

A nightly read of 1,000,000 devices is about 35 devices a second (an estimate, not a measurement),
which one server could send. A central reader still fails at that size because it needs every site
to open SNMP and SSH inbound, carries SNMP over the WAN as UDP (about 80 round trips per access
switch, each paying the WAN delay; large replies fragment), and reaches every management network
from one box. Zabbix documents the same reasons for its proxies: remote locations, one outbound TCP
connection per proxy, and offloading the server "when monitoring thousands of devices" (Zabbix
manual, "Proxies", read 2026-11-02). SNMPv3 adds two discovery round trips per device and a ±150 s
time window (RFC 3414 §4 and §3.2).

### 8.2 Rules that do not survive a million devices (the owner's call, approved on r90)

The owner's note on r90, verbatim: *"3. should probably be both since a technician would have
those? I'd imagine we'd want to pull MACs and ARPs wouldn't we? Right now we use Splunk and Zabbix.
It we have an importing feature that'd be nice. Is there anything we could do for CPE Calix's and
Nokias?"* Items 3 and 4 below carry the first two sentences; §9 carries the rest.


1. **Audit:** ADR-0071 writes one `vault_read` entry per use on the organisation chain. Scheduled
   reads instead write one entry per batch, binding the SHA-256 of the batch's list of (device,
   login, purpose, time, reader); the list is stored beside it, so any single read stays provable.
   The org chain appends under one advisory lock (`chains.rs`) and `verify_org` walks every entry,
   so a million entries a night is a cost on every later verify.
2. **Logins:** "used on" may name a folder (site or building) or a management range, as well as a
   device. The owner's choice, the second admin for a shared login, Draw, and the per-batch audit
   all still apply.
3. **First contact, both ways (the owner's "both").** After a range's first read, a Steward may
   approve its SSH host keys and SNMPv3 engine IDs as one list (downloadable before approval). And
   a technician, anyone with Draw on the design, may confirm **one** device: a new one, or one
   whose key changed after a swap. The page shows the fingerprint the reader saw; the technician
   reads the device's own fingerprint off its console and types its last eight characters. A match
   confirms it; a mismatch confirms nothing and says so. Typing, not a button, is the point: it
   proves someone compared the key with the device, which is what stops a reader being pointed at
   an impostor. A key or engine ID that later changes still stops reads of that device until one of
   the two confirms it (ADR-0082 §4.4 unchanged there). Each confirmation, bulk or single, is sealed
   on the design's chain with who confirmed it and how.
4. **Tiers:** inventory (ENTITY-MIB, `sysDescr`) weekly; interfaces and LLDP nightly. **MAC and ARP
   tables** (the owner: *"we'd want to pull MACs and ARPs"*): on request anywhere, and on a
   schedule for each site or range a Steward turns it on for (every night by default once on). The
   reader keeps only the MAC addresses learned on **edge ports**, the ones with no LLDP neighbour
   that is itself a switch or router, so "Find this MAC" answers with the port something is
   plugged into, not every uplink it crossed; ARP tables (from routers and layer-3 switches) are
   kept whole, since they map addresses to MACs. Both are stored as latest reading plus changes
   (§8.3), so "where was this MAC last week" works. The walk itself costs the device the same
   either way; the schedule and pacing (§4.8) are what limit that. Going ahead on this; r91
   question 1 offers "every night everywhere" and "on request only" for the owner to change it.

### 8.3 Engineering changes, no question needed

- **Work plans, not job rows.** A reader receives one plan per range and paces itself; it reports in
  batches. The database holds plans and leases, not a row per device per night.
- **Latest and changes.** Each device keeps its latest reading (sealed) and a list of changes. An
  unchanged device writes only "checked at", from a fingerprint the reader sends instead of the
  reading. Reading writes commit with `synchronous_commit = local`: a reading lost in a failover is
  read again. PostgreSQL allows exactly this: *"It is therefore possible, and useful, to have some
  transactions commit synchronously and others asynchronously"* (`synchronous_commit`, v17 text).
- **Ranges signed by a Steward.** §4.4's "signed update from the server" becomes "signed by a
  Steward's own key", verified by the reader, so a Fathom server that has been taken over cannot
  widen a reader's reach. To be confirmed against how ADR-0081 signs team acts.
- **Fleet upkeep.** The server accepts the current and previous reader protocol version;
  certificates renew over the existing link; readers report their clock offset; Admin lists readers
  that are behind. Results a reader holds while offline are sealed to the server's key.
- **Later, a source beside the readers:** an existing monitoring system (LibreNMS, Zabbix and
  others), so devices are not polled twice. Ticked on r90; the owner named Zabbix and Splunk in the
  note, so §9 takes it up now.

### 8.4 The estate index on main (fixed in its own PR, not here)

Measured 2026-11-02 on PostgreSQL 16.15 (4 cores) with migration 0058's tables, 1,000 designs of
1,000 devices and 20 terms each (20,000,000 term rows, 6.8 GB with indexes), second run:

| Operation | main | fixed |
|---|---|---|
| Delete one design's rows (FK cascade to `estate_terms`) | 3.1 s for 1 row, 17.9 s for 10 (about 30 to 50 min for 1,000, extrapolated) | 20 ms for 1,000, with an index on `estate_terms (organisation_id, design_id, element_id)` (241 MB) |
| One common term | 350 to 560 ms | 0.13 to 0.4 ms (no `GROUP BY`; stops at the limit) |
| A rare term plus `kind:device` | 15.1 to 15.3 s | 0.1 to 1.2 ms (kind from `estate_rows`) |
| Two common terms | 130 to 320 ms | 17 ms (rarer term drives, `NOT EXISTS` probes for the others) |

Also from reading the code: two servers can rebuild one design at once (the `Scheduler` is per
process), and the older rebuild can commit last. The fix takes a per-design advisory lock and never
replaces rows built from a newer version. A rebuild of a 1,000-device design wrote 57 MB of WAL;
rebuilding only changed elements, and committing the index (derived data) without waiting for the
synchronous standby, keep that off the HA link.

## 9. What other systems already know: Zabbix, Splunk, Calix and Nokia (accepted on r91-systems-and-cpe; §9.6 reworked, r91 v2)

The rest of the owner's note on r90 (§8.2): *"Right now we use Splunk and Zabbix. It we have an
importing feature that'd be nice. Is there anything we could do for CPE Calix's and Nokias?"*

### 9.1 Facts this rests on

Read on 2026-11-02 from the sources named (CLAUDE.md rule 1). Where a vendor's own page could not be
read, the third-party source is named as such.

| Fact | Source |
|---|---|
| Splunk's REST API starts a search with a POST to `/services/search/jobs/` and exports its results with a GET on the job's `/results`; `output_mode` is one of `atom`, `csv`, `json`, `json_cols`, `json_rows`, `raw`, `xml`. Splunk Cloud Platform needs the REST API enabled through a support ticket; free trials cannot use it. | Splunk Enterprise 9.4 Search Manual, "Export data using the Splunk REST API" (help.splunk.com) |
| A Zabbix host interface's `details` object is *"Required if interface 'type' is SNMP"*. | Zabbix 5.0 manual, API, Host interface object |
| `host.get` with `selectInterfaces` returns each host's interfaces with the fields asked for. | sbcode.net, "Zabbix API examples" (third party) |
| **Could not establish:** from Zabbix's own 7.0 pages (only their menus came through), which inventory fields `host.get` returns, and whether the API or a host export returns SNMP community strings or SNMPv3 passphrases. §9.3 is written so the answer does not matter. | — |
| Nokia Altiplano's northbound APIs are REST and RESTCONF to the Access Controller, NETCONF, and Kafka notifications, used *"to configure devices and collect network information"*. | Nokia training, "Altiplano Northbound API" course page |
| ServiceNow's Altiplano connector reads OLTs, ONUs/ONTs, cards, slots, ports, VLANs, LAGs and the PON links between OLT and ONT over REST, with an access token from Altiplano; its example query returns each ONU's detected serial number and hardware state. | ServiceNow docs, "Service Graph Connector for Nokia Altiplano" and "Examples of retrieving data from Nokia Altiplano via REST API" |
| Nokia MF OLTs answer NETCONF directly (TCP 831 to 833); Altiplano-managed PON is read through Altiplano's REST API over HTTPS with an OAuth bearer token, and the OLT reports each ONT's serial to Altiplano. | RG Nets rXg manual, "Nokia PON/MF Systems" (third party) |
| Calix Cloud has a "Subscriber/Device API" at `https://gcs.calix.com:8444/` (Canada `gcs-ca`), device path `/api/device`, Basic authentication with an "API for Web Clients (HTTPS)" user made in Calix Cloud's admin menu. | Postman collection "Calix Cloud - Subscriber/Device API" (documenter.gw.postman.com) |
| Calix SMx has a northbound REST API under `https://{SMx}:{port}/rest/v1/`. Calix's own SMx API guide refuses automated reading, so its calls are not established here. | KalebFenley/smx-api README (third party, a proof of concept reading alarms) |
| Calix's end-of-life page lists, for CMS, only an end of sale for its Dell R430 appliance (CAB-18-028) and an end of support for its Oracle server option (CAB-18-017), not for CMS itself. It says *"Calix C-Series systems will reach End of Support status on December 31, 2026"*, and that T-Series ONTs *"have reached End of Support status"*. | calix.com/eol |
| CMS's northbound interface is *"a separately licensed part of CMS (R15.x, SOAP over HTTP or HTTPS)"*. | Joshkcal52/calix-gpon-cms-api README (third party) |
| Polled directly over SNMP, E7 EXA nodes list *"the GPON ports, ONTs, ONT eth ports, and ethernet interfaces"* as interfaces; traffic and light levels came only through CMS. | LibreNMS community forum, "Calix E7 EXA GPON port traffic", 2023-07-07 (third party) |
| Nokia's 5620 SAM manages Nokia's IP/MPLS routers and switches (7750 SR, 7450 ESS, 7210 SAS and others) and some third-party gear. | ipcisco.com, "Nokia 5620 SAM" (third party) |
| Nokia's NSP *"has evolved from the 5620 SAM"*; its packet manager, NFM-P, is *"an advanced IP/MPLS and mobile network management system"* whose XML API is SOAP over HTTP or HTTPS with JMS notifications, and needs a licence key and a user group with the OSS management scope. | Nokia SReXperts Americas 2017, "Transitioning from 5620 SAM to the Network Services Platform"; NSP 24.4 Glossary and XML API Developer Guide |
| **Could not establish:** whether 5620 SAM itself is still supported (Nokia's pages found say only that NSP evolved from it), or whether it holds any PON or CPE inventory. Nokia's PON element manager is a different product, AMS, *"element management system for the Intelligent Services Access Manager (ISAM) broadband access nodes"* (nokia.com, Access Management System). | — |
| TR-369 (USP) is the Broadband Forum's successor to TR-069 (CWMP) for managing home gateways and Wi-Fi, and allows several controllers per device. | QA Cafe, "User Services Platform (TR-369) overview" |

### 9.2 Why this is more than "nice"

The owner expects close to a million entries at the start (§8). They will not be drawn by hand.
Zabbix already lists the network's devices with their addresses, and the OLTs already know every
ONT on their PON ports (§9.6). Reading them is how the estate is first filled; reading them again on a schedule is how it stays
true **without polling a million CPEs**, which §8 exists to avoid.

### 9.3 One shape for every outside system (recommended, r91 question 2, A)

- **A source is a system, not a device:** a Zabbix server, a Splunk saved search, and later SMx,
  Calix Cloud or Altiplano if the owner moves to them (§9.6). A Steward adds it under Steward › Device reading › Sources: its address, the
  reader that calls it, and a login from the vault.
- **A reader calls it, never the server** (§4.1): the reader near it, or `local`. The same two
  locks as for devices (§4.4): the source's address must be in that reader's ranges, and the calls
  are fixed in the reader's code for each system, read calls only, named by purpose ("hosts",
  "onts"). For Splunk the job names a saved search the Steward picked; the Splunk account's own
  role bounds what any search can read.
- **The login is a vault login** (ADR-0071), sealed per job to the reader (§4.3): a Zabbix API
  token, a Splunk token, an SMx or Calix Cloud API user, an Altiplano client. Fathom asks for the
  narrowest read-only role each system offers; which role that is gets established, with sources,
  for each system when it is built, and goes into `docs/OPERATING.md`.
- **Only named fields come back.** The reader keeps, for each system, a fixed list of the fields it
  copies (host name, addresses, interface type, SNMP version, host groups, serial, model, ONT's OLT
  and port), the same idea as the fixed OID list. Anything not on the list, including all of a
  Zabbix interface's SNMP `details` beyond its version, is never copied. The redaction gate still
  runs on what is copied (§4.5) and the server still refuses a credential that arrives. The list
  comes first because the gate alone is not enough here: ADR-0067 records that it is
  statement-driven and *"a bare secret in a cell with no statement around it is not caught"*, and a
  community string in a field named `community` is exactly that. Its test uses a community string
  and SNMPv3 passphrases of the lengths real devices accept (CLAUDE.md rule 2).
- **Splunk rows are whatever the search returns**, and log lines can carry passwords. Only the
  columns the Steward maps are kept; a column whose name says password, secret, community, key or
  token cannot be mapped.
- **The first run fills, later runs compare.** The first run creates what is missing, as NetBox
  import on Folders does today (ADR-0074 §8): a Zabbix host group maps to a folder or site, a host
  to a device in that site's design, and an existing design is not overwritten. Every later run is
  a reading like a device's (§4.6): what differs from the record is listed for a person to accept.
- **Each thing keeps its source's id** (a Zabbix `hostid`, an ONT serial) so a later run matches it.
  These are new fields; they enter `schema/` through the ledger when built (CLAUDE.md rule 3).

**(r91 question 2, B) Files only.** Export from each system and drop the file into Import. No
connection and no stored token, but by hand, and today's importer caps a file at 2,000 rows and
5 MB per design (ADR-0067), so a million entries is hundreds of drops, and nothing stays in step.

### 9.4 Zabbix

`host.get` with interfaces and inventory, read in pages by host group. What Zabbix holds (names,
addresses, model and serial where its inventory is filled in) Fathom does not read from the device
again; what it does not hold (LLDP neighbours, ports, MAC and ARP) still comes from Fathom's
readers. Where Zabbix has a proxy at a site, the site reader can sit on the same machine: both need
the same reach into the management network.

### 9.5 Splunk

Splunk holds events, not an inventory, and what it can give Fathom depends on what is logged into
it (DHCP leases, neighbour or MAC moves). **Now, no new code:** a search's results saved as CSV go
into today's importer, one site of up to 2,000 rows at a time. **Later:** a Splunk source runs a
saved search the Steward picks, on a schedule, through a reader, with the REST calls in §9.1, and
treats its rows as a reading.

### 9.6 Calix and Nokia CPE (reworked after r91's note; recommended, r91 v2 A)

r91 version 1 recommended reading CPE through SMx, Calix Cloud and Altiplano (§9.1). The owner
approved it with a note: *"for 3. We don't use any of those, we use Calix CMS and Nokia SAM, which i
think both are unsupported now."* (Key Maker, 2026-11-02.) What the sources say about that (§9.1):
Calix lists no end of support for CMS itself, but its C-Series (C7) systems lose support on 31
December 2026. Whether 5620 SAM is still supported could not be established, and the sources found
describe it managing IP/MPLS routers, not PON, so it likely does not know the CPE at all. Neither is
a source worth building for first.

- **(A) Read the OLTs directly with the site readers.** The OLT knows every ONT on its PON ports.
  The readers already read the OLTs as network devices (nightly interfaces, weekly inventory), with
  a login the vault already holds for them, so the ONT list is one more purpose on that OLT
  family's fixed list, not a new connection. An E7 EXA already lists its ONTs as interfaces over
  SNMP (§9.1); whether serials come the same way, or need the E7's CLI over SSH, is established
  against a real E7 when built. It works whatever manages the OLT, so it survives a move off CMS
  or SAM. Fathom never connects to a CPE.
- **(B) Read CMS's northbound interface.** One connection for every Calix node CMS manages, but
  it is a separately licensed part of an older system, and there is nothing equivalent for Nokia.
- **(C) Wait until SMx or Altiplano is in.** Nothing built for CPE until then; §9.6's version 1
  plan applies when it is.

Rejected, as in version 1: reading CPE as a TR-069 or TR-369 manager. Those protocols manage a CPE
and a manager can change it, while Fathom reads and never writes (ADR-0082 §2); and every CPE would
have to be set up to answer one more manager.

**Which OLT families.** The first inventory read of each site names its OLTs (`sysDescr`,
ENTITY-MIB), so Fathom lists the families it found and each family's fixed list is added in that
order, most ONTs first, without anyone being asked to list their gear. C7s are not built for: Calix
ends their support on 31 December 2026. Routers that SAM manages are read as devices like any other.

How a million CPEs show in Fathom is **not** decided here. The schema already says an ONT that only
converts is a `PassiveNode` media converter and a CPE that routes is a `router` (`schema.yaml`,
device roles). They will not be drawn one by one; how they show (listed under their OLT port, a
count on the canvas) comes to the owner as mockups on its own card before it is built.

### 9.7 Order

After §7 step 1. Steps 1 and 2 come before the site reader, since the `local` reader can reach a
Zabbix that the server can reach; step 3 needs readers that reach the OLTs:

1. The Splunk CSV route: a worked example in `docs/EXAMPLES.md`, no code.
2. The Zabbix source, first, because it is how the estate is first filled.
3. ONT lists from the OLT families the first inventory reads find (§9.6 A), each with its fixed
   list. SMx, Calix Cloud and Altiplano sources only when the owner moves to them.
4. The Splunk saved-search source.

## Not decided here

- Whether B of §4.3 (logins kept at the site) or B of §4.6 (live up/down) is ever built.
- How CPEs show in Fathom (§9.6), and the OLT families a site reader reads directly.
- The site reader's TLS and HPKE packages: chosen with a dependency record and the owner's tick.
- Reading through a jump host or a controller API (UniFi, Omada).
- FIPS 140-3 builds (the build thread keeps the reader's crypto behind one seam so it can be added).
