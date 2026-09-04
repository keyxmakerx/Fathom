# Open for the owner — everything waiting on a decision

> **Status: Living list. Compiled 2026-09-04 by a full sweep of the corpus.** Ten readers over
> the whole documentation tree found 93 candidate decisions; each was then checked
> adversarially against later documents, `70`, the ADRs and the work orders. **42 were stale
> markers already answered elsewhere and were dropped. 51 survived**, and are consolidated below
> into 27 real questions — several documents ask the same thing in different words.
>
> **Read section A only, if you read nothing else.** Three questions there stop server work.
> Everything below A can wait for a quiet evening.
>
> Plain English throughout. No file references in the questions themselves; the source is in the
> right-hand note if you want to go and read it.

## Contents

| § | |
|---|---|
| A | Blocks the server, now — 3 questions |
| B | Cheap to answer now, expensive once built on — server shape |
| C | Cheap now, expensive later — the data model |
| D | Needs your time, not just your answer — vendor content |
| E | Can wait — look, feel, and smaller calls |
| — | How this list was built · What was dropped |

---

## A. Blocks the server, now

**Three questions. Nothing can be saved on the server until A1 is answered.**

### A1. Where does the master key live?

Every customer's network drawings get locked with their own key. Something has to hold the one
master key that unlocks those keys. The realistic options:

| | what it means | the trade |
|---|---|---|
| **A cloud key service** (AWS KMS, Google, Azure) | the cloud provider holds it and logs every use | simplest, strongest audit trail, and it does not exist on a customer's own hardware |
| **A key vault** (HashiCorp Vault) | a separate piece of software you run | works both hosted and self-hosted; one more thing to run and back up |
| **A protected file on the Fathom server** | a file only the Fathom process may read | no extra kit; a stolen server or a stolen backup tape is much worse |

**And the second half, which is the harder one:** a customer who installs Fathom on their own
hardware with no cloud connection needs an answer too. That answer decides how much extra
equipment and process their IT team has to run.

**Why it cannot wait:** changing this after data is stored means unlocking and re-locking
everything already held. *(ADR-0040 §9 items 1 and 2. WO-11 stored nothing on purpose to keep
this door open.)*

### A2. Does the first release keep an audit log?

The record an employer's security review asks for: **who opened, changed or exported which
network drawing, and when.**

Either it is in the first release, or it is not — and a record started later **can never cover
the period before it existed.** That is the whole of the trade. *(ADR-0040 §9 item 4.)*

### A3. The borrowed-code limit is about to be broken

The project promised to keep the amount of other people's code inside Fathom under a fixed
ceiling (160 packages). The server is at **115** with only four of the sixteen planned pieces in.
Sign-in, passwords, passkeys and company single sign-on are still to come. It will not fit.

Three ways out:

1. **Raise the limit** and write down why.
2. **Drop the biggest optional piece** — company-wide single sign-on is the largest and the most
   deferrable.
3. **Split the limit** — one for the part that runs in a browser, a looser one for the server.
   They are different programs with different risks and never had a reason to share a number.

**Not an option:** meeting the number by removing a safety check.

**Why now:** that number is what you would show an enterprise security reviewer, and it is far
cheaper to settle before the code depends on it. *(WO-11 §9.7.)*

---

## B. Cheap now, expensive later — the shape of the server

### B1. What is the server allowed to dial out to?

The promise that "this software never phones home" was only ever written about the page in the
browser. The server has no such rule written down.

Either **write the short list** — your directory server, your mail relay, your key store, the
certificate authority, and nothing else, with anything missing that block treated as a fault — or
**say plainly, in writing, that the server has no such rule.** Both are defensible. Silence is
not.

### B2. May people sign in with their device password?

If Fathom lets you log in with the same username and password you type into your switches, then
**Fathom receives that device password and passes it to your TACACS+ or RADIUS server on every
login.**

Either that is permanently ruled out — company single sign-on only, so anyone who breaks into
Fathom still walks away without a working login to a single box — or it is allowed, and Fathom
handles device credentials for the first time in its life.

### B3. Your own rulebook says the tool never connects to anything

That rule was written for the offline copy and reads as absolute. The hosted version you have
asked for is, on paper, permanently in breach of it.

Either **rewrite it to say it covers the standalone copy**, or **leave it and explain the
exception every time it comes up.** *(`48` open decision 1. The equivalent rule about keys was
already formally scoped by ADR-0040; this one has not been.)*

### B4. May Fathom call itself the record of your network?

Two very different products:

- **"This is the authoritative record."** An out-of-date entry becomes a fault Fathom must spot
  and keep visibly flagged. Losing your Fathom data becomes as serious as losing the network
  documentation itself.
- **"Here is where each fact came from, and when."** You judge whether it is still true.

The first is worth more and owes more.

---

## C. Cheap now, expensive later — the data model

**These get baked into every record you enter from now on. Answering them late means editing
history.**

### C1. Servers, NAS boxes and hypervisors *(asked four separate ways in the corpus)*

When you hand-draw a Proxmox box, Fathom still makes you pick which **network vendor's operating
system** it runs, and only offers firewall/router/switch platforms. So today your Proxmox box is
filed as a Juniper firewall.

Three routes: **let the field be blank**, **add a plain "it's just a host" entry**, or **treat
hosts as a different kind of thing entirely.**

The catch with blank: that field is half of how Fathom recognises the same box again when you
later paste its real config. A blank one cannot be matched automatically.

### C2. Tags and groups — a real thing, or a typed word?

You asked to group and tag kit. Two shapes:

- **A real named set** you deliberately create and drop equipment into. Survives renaming. Stops
  "Q3 refresh", "Q3-Refresh" and "q3 refresh" becoming three different things.
- **A word you type onto a device.** Faster today, a pile of near-duplicates you cannot filter on
  later.

**And a second half:** should every colleague who opens the drawing read your labels, or do you
need some **private to you**? A private-notes layer is easy to build in from the start and
painful to add once everything is shared by default.

### C3. Can a box do more than one job?

A home gateway routes, firewalls, switches and serves Wi-Fi. Today you pick the single word that
fits best and the other three facts go unrecorded — on every box, from now on.

### C4. Racks — five small ones that travel together

- If you record a switch at U7 and it is really at U9, should you be able to **drag it to the
  right slot**, or must you delete it and add it again, losing its cables and its history?
- Is **"this box is 2U"** a fact about the box, or about that one mounting? Today, unracking it
  forgets how tall it is.
- Can a rack say **which building it is in** on its own, or only through the site it belongs to?
  (A site can point at only one building.)
- Should a **power strip or a UPS** be nameable, or keep sitting in the rack as an unlabelled
  "other" box?
- Should Fathom learn about **shelves, desks and walls**, so a mini-PC on a shelf or an access
  point on a wall can be placed in a building without pretending it is bolted into a rack slot?

### C5. Where you dragged a box on the picture

Fathom files every fact under one of three headings: how a device is **configured**, how it is
physically **built**, or what **service** it carries. "Where you dragged this box" is currently
filed under *configured*, for want of anywhere better.

Do you want a fourth heading for facts about the drawing itself — so no future report, export or
filter can mistake your hand-placed box for something the device actually does?

### C6. Draft and planned work

When you sketch a change you have not made yet, is that:

- a **switch you flip** that changes how the whole tool looks until you flip it back,
- a **status on each device** that sticks to it and everyone else sees, or
- a **coloured filter on your own screen** that changes nothing underneath?

Only the middle one travels with the equipment record into exports and onto colleagues' screens.

### C7. A DHCP relay pointing into a named routing instance

Fathom reads that detail, shows it once, and **throws it away when the design is saved.** So a
reloaded relay silently looks like it lives in the default routing table — and any later "can
this reach that" answer would be worked out against the wrong table.

Three routes: **teach Fathom to read routing-instance blocks properly** (the routing view will
need this anyway — cheapest), **remember the dangling pointer by name** until that instance turns
up, or **re-read your original pasted text every time.**

### C8. Your naming scheme

In the equipment names you build, does the part in front of the CLLI code mean **the state or
province**, or **the kind of site** (central office, hut, cabinet, customer premises)?

Whichever you mean is what the tool stamps onto every name it generates. If it guesses wrong you
fix it by relabelling boxes in the field, not by changing a setting.

### C9. LTE backup and voice

Is an LTE card at a customer site **a service in its own right**, like an E-Line or an E-LAN — or
**just the second way that site gets reached**?

If LTE is its own service, every site with LTE backup shows up as two unrelated services someone
has to link by hand, and you cannot ask the system which circuits actually have a backup path.

---

## D. Needs your time, not just your answer

### D1. Which vendors next — and one release each

**Today Fathom truly reads Juniper SRX and nothing else.** A Palo Alto, FortiGate, Nexus, Arista
or OPNsense config pasted in comes back mostly as unread text **with far weaker password
stripping** — and under the rule just ratified, no other brand can be switched on until someone
reads that vendor's own manuals and writes down what its password keywords look like.

Two parts: **which brands next** (finish Juniper MX and EX, or jump to Palo Alto / Nexus?), and
**one pinned software release per family** — because right now every piece of advice Fathom gives
silently claims to be true on every release those boxes have ever run, and nobody can put their
name to a claim that broad.

### D2. Will you put your name on the guidance?

About **330 Juniper command write-ups, rules and explanations** would be shown to other
engineers. Until a real person vouches for them, none can honestly be shown as guidance. Every
week it goes unanswered the pile gets bigger.

Also: **do you actually have Calix and Nokia gear** to check that part on, or should Fathom stick
to the Juniper, Cisco and Palo Alto kit you named as yours?

### D3. Is the fibre-access world the same job? *(asked twice)*

The Calix and Nokia gear, the CLLI-coded sites, the DIA / E-Line / E-LAN services — **the same
job as the Juniper boxes you configure, seen from the other end, or a genuinely separate second
job?**

That decides whether Fathom has to learn to read Calix and Nokia configs the way it reads Junos —
its own parsers and command knowledge, **a months-long track** — or whether recording that gear
as inventory you fill in by hand is enough.

### D4. Reading and writing a vendor's language

When Fathom learns a vendor's config language, should the one file that teaches it to **read** a
line also carry the rule for **writing** that line back out — or stay two separately-maintained
halves with a test comparing them? Worth settling before a second vendor is taught.

---

## E. Can wait

- **Dark or light by default?** Whatever ships is what everyone sees before they touch a setting
  — and the green/amber/red you rely on for "safe / careful / danger" are different inks on a
  dark page and have to be re-proven readable first.
- **Themeable like a terminal** (gruvbox, nord, dracula) — on condition the three warning colours
  are frozen, so a pretty theme can never change what a warning colour is telling you?
- **Corners:** dead-square like a printed form, or barely softened like a machined panel edge?
- **The "might be a password" warning:** should it also flag values that just look like random
  gibberish (occasionally nagging about harmless notes), and should it take account of what the
  box is *called* — so a weak value like `public` in a field labelled SNMP community gets flagged?
- **The IKE warning:** flag the one interface, or the whole zone? (Decides what the one-click fix
  opens.)
- **Ten 10-gig runs between two boxes:** draw ten lines or one labelled "10 links"? — and it must
  never make ten standalone links look like a single port-channel.
- **A scanned floor plan behind the drawing** — useful, but nothing can tell you it is current or
  even the right building, and it would be missing from every export. Plus: cap its size, in the
  browser or on the server?
- **Following a connection hop by hop:** light it up on the drawing you are looking at, or open
  its own screen? (There are only six screens and all six are claimed.)
- **Named lists you build yourself** — "the Q3 firewall refresh", "PCI scope" — spanning several
  sites and customers, saved and handed on as one thing? Or is filtering the inventory each time
  enough?
- **Version bug lists** — "don't run that release, it has this bug." Worth paying a named person
  to write and re-check? A stale bug list is worse than none.

---

## How this list was built

Ten parallel readers over the whole `docs/` tree, `.context/`, the ADRs and the work orders, each
returning only decisions the documents themselves record as open, with a verbatim quote. Then
**every candidate was attacked**: an independent check read the cited section and searched for a
later answer in `CLAUDE.md`, `70`, the ADRs, the work orders and the git history, defaulting to
"already answered" whenever it found one.

**That is why the list is 27 and not 93.** This corpus has a known habit of leaving a question
marked open after it was answered somewhere else — several such markers were found and closed in
the last few days alone. A stale question reported as live wastes the scarcest thing here, which
is your attention.

## What was dropped, and why that matters

**42 of 93 candidates were stale.** If a question you remember being asked is not in this list, it
is most likely because it was already answered — in `70` (your own words, recorded verbatim), in
an ADR, or in a work order's as-built note. Ask and it can be shown to you.
