# Open for the owner — everything waiting on a decision

> **Status: Living list. Compiled 2026-09-04 by a full sweep of the corpus.** Ten readers over
> the whole documentation tree found 93 candidate decisions; each was then checked
> adversarially against later documents, `70`, the ADRs and the work orders. **42 were stale
> markers already answered elsewhere and were dropped. 51 survived**, and are consolidated below
> into 27 real questions — several documents ask the same thing in different words.
>
> **Read sections A and B only, if you read nothing else.**
>
> **A** is three questions the corpus already knew it was waiting on. **B is more important and
> newer**: a final pass asked *"what does a server product need decided that a single offline
> file never did — and has anyone actually asked it?"* It found twelve questions **nobody has
> ever put to you**, six of which block the server. One of them is a direct contradiction
> between an accepted decision record and everything written since the pivot.
>
> Plain English throughout. No file references in the questions themselves; the source is in the
> right-hand note if you want to go and read it.

## Contents

| § | |
|---|---|
| A | Blocks the server, now — 3 questions |
| B | **The questions nobody has asked yet** — 12, six of them blocking |
| C | Cheap to answer now, expensive once built on — server shape |
| D | Cheap now, expensive later — the data model |
| E | Needs your time, not just your answer — vendor content |
| F | Can wait — look, feel, and smaller calls |
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

## B. The questions nobody has asked yet

**These are not in anyone's open-decisions list.** They came from asking what a server product
needs settled that a single offline file never did, and then checking whether the corpus had
decided it or merely never raised it. Every one below is the second.

**Six of them block the server.**

### B1. ⛔ Are you running this, or shipping it? *(and the corpus contradicts itself)*

Do you intend to **run Fathom yourself as a service other people log into over the internet**, or
**ship it as software each customer installs on their own server**?

**The project's own accepted decision says you will never run one — and every word written since
the pivot assumes you will.** Verified 2026-09-04: it is **ADR-0003**, still *Accepted*, titled
*"Fathom is a tool, not a business, and there is no hosted service"*, whose first decision reads
*"No hosted service, no accounts we run, no plan tiers."* `49` (2026-08-18) assumes hosted and
multi-tenant throughout and never reopens it. Resolving it is an ADR that amends or supersedes
0003 — planning work once you have answered, never an execution session's.

It is the question underneath most of the rest of this section. Answer it first.

### B2. ⛔ May you read a customer's network map?

The server can now decrypt every customer's drawings. So: **may you, or whoever operates the
server, actually open one** — to chase a fault, or to let a locked-out customer back in?

And if you do: **is the customer told? Does it leave a record nobody can switch off?**

This is the question an enterprise buyer asks in the first meeting. There is no answer on paper.

### B3. ⛔ Backups — who, how often, how long, and where is the key?

Four parts, all unanswered: **who takes them**, **how much work may be lost if the server dies**,
**how long a backup is kept**, and **where the key that unlocks a restored backup sits**.

That last part is the one that interacts with A1 — a backup you cannot decrypt is not a backup,
and a backup anyone can decrypt is a second copy of the problem.

### B4. ⛔ Inside one customer's company, who sees what?

Is a new drawing **private to whoever made it until it is shared**, or **visible to the whole
company by default**?

And what jobs exist — look only, edit, invite people, run the account? Every read path in the
product depends on this, which is why it is expensive to add late.

### B5. ⛔ Can a stranger sign themselves up?

On a Fathom you run, can someone on the internet **make themselves an account and a brand-new
company workspace** — or does a company only exist because **you** set it up and invite the first
person in?

### B6. ⛔ Does the browser version keep growing while the server is built?

The server is months of work. Meanwhile the single-file version you use today is the one that
actually works.

**Does it keep gaining features, or freeze where it is?** The plan says it is being dropped — and
every new gesture added to it has to be built a second time against the server.

### B7. What does a customer get back when they leave?

**In what form**, **how long do you keep their data before destroying it**, and **who is allowed
to ask you to destroy it**?

### B8. What are you promising about it staying up?

Best effort with no promise at all, or a stated target — and **who gets woken at three in the
morning** when it is not?

### B9. Who does the first customer have a contract with?

**You personally, or a company you have set up** — and what are you agreeing to in writing about
their data, including **how quickly you must tell them if it leaks**?

### B10. Who pays for the vendor knowledge?

Writing and re-checking what Fathom teaches is a near-full-time job. Is anyone funding it — an
employer who gets the tool as internal kit, a vendor, or nobody?

**The project's own risk register names this the thing most likely to kill it, and required an
answer before this stage.** It never got one.

### B11. What does "live multi-user editing" actually mean?

Is it satisfied by **seeing who else has the drawing open, plus a soft lock saying "Dana is
editing this box"** — or must **two people type into the same box in the same second**?

The gap between those two is enormous in engineering terms and they sound identical when spoken.

### B12. Should Fathom ever hold vendor firmware images?

The recommendation on file is **no** — only generate the setup for a firmware server your
customer runs. But it turns on **licence agreements only you can read.**

---

## C. Cheap now, expensive later — the shape of the server

### C1. What is the server allowed to dial out to?

The promise that "this software never phones home" was only ever written about the page in the
browser. The server has no such rule written down.

Either **write the short list** — your directory server, your mail relay, your key store, the
certificate authority, and nothing else, with anything missing that block treated as a fault — or
**say plainly, in writing, that the server has no such rule.** Both are defensible. Silence is
not.

### C2. May people sign in with their device password?

If Fathom lets you log in with the same username and password you type into your switches, then
**Fathom receives that device password and passes it to your TACACS+ or RADIUS server on every
login.**

Either that is permanently ruled out — company single sign-on only, so anyone who breaks into
Fathom still walks away without a working login to a single box — or it is allowed, and Fathom
handles device credentials for the first time in its life.

### C3. Your own rulebook says the tool never connects to anything

That rule was written for the offline copy and reads as absolute. The hosted version you have
asked for is, on paper, permanently in breach of it.

Either **rewrite it to say it covers the standalone copy**, or **leave it and explain the
exception every time it comes up.** *(`48` open decision 1. The equivalent rule about keys was
already formally scoped by ADR-0040; this one has not been.)*

### C4. May Fathom call itself the record of your network?

Two very different products:

- **"This is the authoritative record."** An out-of-date entry becomes a fault Fathom must spot
  and keep visibly flagged. Losing your Fathom data becomes as serious as losing the network
  documentation itself.
- **"Here is where each fact came from, and when."** You judge whether it is still true.

The first is worth more and owes more.

---

## D. Cheap now, expensive later — the data model

**These get baked into every record you enter from now on. Answering them late means editing
history.**

### D1. Servers, NAS boxes and hypervisors *(asked four separate ways in the corpus)*

When you hand-draw a Proxmox box, Fathom still makes you pick which **network vendor's operating
system** it runs, and only offers firewall/router/switch platforms. So today your Proxmox box is
filed as a Juniper firewall.

Three routes: **let the field be blank**, **add a plain "it's just a host" entry**, or **treat
hosts as a different kind of thing entirely.**

The catch with blank: that field is half of how Fathom recognises the same box again when you
later paste its real config. A blank one cannot be matched automatically.

### D2. Tags and groups — a real thing, or a typed word?

> **ANSWERED 2026-09-04: a real named set.** Recorded verbatim in `70` §19.1. It is a schema
> decision — a kind with its own identity, so renaming survives and "Q3 refresh" / "Q3-Refresh" /
> "q3 refresh" are one thing. By ADR-0008 nothing "per group" can be built until that kind exists,
> so the schema work is on the critical path for the SCP/SFTP generation asked for in the same
> breath. **Still open beneath it:** the kind's name, whether a device may be in several groups,
> whether groups nest, and whether one may span sites.
>
> **And the second half below was answered on a different axis than it was asked.** See §D10.

You asked to group and tag kit. Two shapes:

- **A real named set** you deliberately create and drop equipment into. Survives renaming. Stops
  "Q3 refresh", "Q3-Refresh" and "q3 refresh" becoming three different things.
- **A word you type onto a device.** Faster today, a pile of near-duplicates you cannot filter on
  later.

**And a second half:** should every colleague who opens the drawing read your labels, or do you
need some **private to you**? A private-notes layer is easy to build in from the start and
painful to add once everything is shared by default.

### D10. Is a group visible to everyone in the organisation? *(narrowed 2026-09-04)*

Asked whether labels and notes should be shared or private to you, you answered on a different
axis — **"think of the meraki dashboard right, you have a per organization tab, a per network tab,
and then a per device tab"** (`70` §19.2). That is a scope hierarchy, and it is now the shape the
equipment manager is being designed to, mapping onto tenant → `Site` → `Device`.

**So the privacy question survives, smaller and better posed:** a group is now a real named set
(§D2). **Can everyone in your organisation see one, or can a group be private to the person who
made it?**

The same applies to notes you type on equipment. It is cheap to decide now and painful to retrofit,
because it touches every read path — which was the true half of the original question.

### D3. Can a box do more than one job?

A home gateway routes, firewalls, switches and serves Wi-Fi. Today you pick the single word that
fits best and the other three facts go unrecorded — on every box, from now on.

### D4. Racks — five small ones that travel together

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

### D5. Where you dragged a box on the picture

Fathom files every fact under one of three headings: how a device is **configured**, how it is
physically **built**, or what **service** it carries. "Where you dragged this box" is currently
filed under *configured*, for want of anywhere better.

Do you want a fourth heading for facts about the drawing itself — so no future report, export or
filter can mistake your hand-placed box for something the device actually does?

### D6. Draft and planned work

When you sketch a change you have not made yet, is that:

- a **switch you flip** that changes how the whole tool looks until you flip it back,
- a **status on each device** that sticks to it and everyone else sees, or
- a **coloured filter on your own screen** that changes nothing underneath?

Only the middle one travels with the equipment record into exports and onto colleagues' screens.

### D7. A DHCP relay pointing into a named routing instance

Fathom reads that detail, shows it once, and **throws it away when the design is saved.** So a
reloaded relay silently looks like it lives in the default routing table — and any later "can
this reach that" answer would be worked out against the wrong table.

Three routes: **teach Fathom to read routing-instance blocks properly** (the routing view will
need this anyway — cheapest), **remember the dangling pointer by name** until that instance turns
up, or **re-read your original pasted text every time.**

### D8. Your naming scheme

In the equipment names you build, does the part in front of the CLLI code mean **the state or
province**, or **the kind of site** (central office, hut, cabinet, customer premises)?

Whichever you mean is what the tool stamps onto every name it generates. If it guesses wrong you
fix it by relabelling boxes in the field, not by changing a setting.

### D9. LTE backup and voice

Is an LTE card at a customer site **a service in its own right**, like an E-Line or an E-LAN — or
**just the second way that site gets reached**?

If LTE is its own service, every site with LTE backup shows up as two unrelated services someone
has to link by hand, and you cannot ask the system which circuits actually have a backup path.

---

## E. Needs your time, not just your answer

### E1. Which vendors next — and one release each

**Today Fathom truly reads Juniper SRX and nothing else.** A Palo Alto, FortiGate, Nexus, Arista
or OPNsense config pasted in comes back mostly as unread text **with far weaker password
stripping** — and under the rule just ratified, no other brand can be switched on until someone
reads that vendor's own manuals and writes down what its password keywords look like.

Two parts: **which brands next** (finish Juniper MX and EX, or jump to Palo Alto / Nexus?), and
**one pinned software release per family** — because right now every piece of advice Fathom gives
silently claims to be true on every release those boxes have ever run, and nobody can put their
name to a claim that broad.

### E2. Will you put your name on the guidance?

About **330 Juniper command write-ups, rules and explanations** would be shown to other
engineers. Until a real person vouches for them, none can honestly be shown as guidance. Every
week it goes unanswered the pile gets bigger.

Also: **do you actually have Calix and Nokia gear** to check that part on, or should Fathom stick
to the Juniper, Cisco and Palo Alto kit you named as yours?

### E3. Is the fibre-access world the same job? *(asked twice)*

The Calix and Nokia gear, the CLLI-coded sites, the DIA / E-Line / E-LAN services — **the same
job as the Juniper boxes you configure, seen from the other end, or a genuinely separate second
job?**

That decides whether Fathom has to learn to read Calix and Nokia configs the way it reads Junos —
its own parsers and command knowledge, **a months-long track** — or whether recording that gear
as inventory you fill in by hand is enough.

### E4. Reading and writing a vendor's language

When Fathom learns a vendor's config language, should the one file that teaches it to **read** a
line also carry the rule for **writing** that line back out — or stay two separately-maintained
halves with a test comparing them? Worth settling before a second vendor is taught.

---

## F. Can wait

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

## Two corrections found while checking, both worth knowing

1. **The password-stripping gap is worse than the documents say.** `49` §22 and ADR-0040 D8 both
   state that *seven of ten* registered platforms have no secret dictionary. Counted on disk
   today it is **nine of ten** — OPNsense has one file and it declares no secrets at all. So
   "there is no credential to steal" is earned on **Juniper alone**. That sharpens E1.
2. **The shipped theme default is not light, it is *auto*.** `49` §14's comparison table says
   "Fathom today: light". The page actually boots with no theme set and follows the operating
   system, so an owner on a dark-preferring machine already gets dark. That does not settle F1 —
   it sharpens it to "what happens when the OS says nothing?"

## Seven questions could not be checked

Seven verification passes failed on an infrastructure error rather than a finding, so these were
neither confirmed open nor confirmed answered: the scope of invariant 1, hosting firmware images,
per-site diagram partitions, required fields on an empty chart, a top-down view, the type token,
and passive plant. **Treat them as unknown, not closed.** They are cheap to re-check.

## What was dropped, and why that matters

**42 of 93 candidates were stale.** If a question you remember being asked is not in this list, it
is most likely because it was already answered — in `70` (your own words, recorded verbatim), in
an ADR, or in a work order's as-built note. Ask and it can be shown to you.
