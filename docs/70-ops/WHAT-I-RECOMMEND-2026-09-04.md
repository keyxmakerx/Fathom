# What I recommend, and what I need from you — 2026-09-04

> **Status: written for the owner, in plain English, after a day of research and review.** Fourteen
> decisions were each researched by one agent and then attacked by a second; every attack struck
> over-claims and bad citations and left the recommendation standing; the corrections are applied
> in the technical companion, `RECOMMENDATIONS-2026-09-04.md`. Three more I judged directly from
> documents already on disk. I also looked at the actual product in a browser and read the
> cryptography in WO-12 myself. **Sections 1 and 3 need nothing from you. Section 2 does.**

## Contents

| § | |
|---|---|
| 1 | Decided for you — seventeen things, one line each |
| 2 | **Eight questions only you can answer** |
| 3 | What I saw when I opened the product |
| 4 | What I checked personally |
| 5 | What can wait |

---

## 1. Decided for you

These are technical. You said you can't answer them; you don't need to. Each is one line here and
several pages in the companion, with sources and dates.

**Security**

- **The audit record starts on day one.** Who opened, changed or exported which drawing, and when.
  A record started later can never cover the time before it existed. Small, fixed list of events;
  the screen to read it comes later, the record itself cannot.
- **Nobody signs in to Fathom with a switch password.** Company login or a Fathom-only password.
  If Fathom relayed device passwords, anyone who broke in could collect one for every box.
- **The server gets a written list of what it may connect to.** Its database, your company's
  login service, a mail relay, the key store, the certificate authority. Nothing else, and never a
  network device. Anything off the list fails instead of quietly working.
- **The firmware login design stays, relabelled "documented, not yet tested".** Your Juniper boxes
  have a built-in command to make their own login key and a download command that accepts it. I
  verified both in Juniper's own published files, line by line. Arista shows no such thing. A
  thirty-minute test on real boxes settles it. The shared-password route stays rejected.

**How things are recorded**

- **Groups and tags are two separate things**, kept apart on purpose. A group is a named list you
  make. A tag is a word you type, and Fathom reuses it if it exists. One box can be in many groups,
  a group can span sites, groups don't nest.
- **A box can have more than one job.** Router and firewall and switch on one box, from the same
  seven words, no new ones.
- **Racks:** dragging a box to the right slot is a button that was refused on purpose, not a data
  problem. "This box is 2U" becomes something you type once on the box. Shelves, power strips and
  UPSes become one new kind of thing with one word on it.
- **"Where you dragged a box" gets its own heading**, separate from how the device is configured,
  so nothing that later re-reads a config can touch it.
- **"Planned" is a word that sticks to a box.** Saved with it, seen by everyone, never judged by
  Fathom. You take it off yourself when the thing is built.
- **The DHCP relay bug** is fixed by teaching Fathom to read the routing-table block in your config.
  The relay's arrow then has something to land on and survives a save.
- **When Fathom learns to read a line of vendor config, the same entry writes it back.** One file,
  one reviewer. The two-copy alternative has already drifted on Juniper alone.
- **A server or NAS can be added with the platform left blank.** It shows as a to-do until filled
  in. Today you have to lie and call it a Juniper firewall.

**Housekeeping**

- **The borrowed-code limit was always per program.** The browser page has zero outside code, so
  the server's limit is its own. The one crate worth dropping from the first release is the
  single-sign-on stack, which your own answer about LDAP makes deferrable.
- **The "never connects to anything" rule gets a decision record scoping it to the standalone copy**,
  the same way the keys rule got one. You said this on 2026-08-18; it was never written down.
- **"Is Fathom the authoritative record?"** was already refused in the founding document. Fathom
  is the record of what you told it, with where each fact came from. Question closed.
- **The master key goes in a key-vault service**, not a file on the server. Which one depends on
  your answer to question 2 below.
- **An admin may open any drawing, but never quietly.** A switched-on mode, a typed reason, the
  drawing's people told, a permanent record. Question 6 asks one detail.

---

## 2. Eight questions only you can answer

> **Answered the same evening, all eight, in two rounds.** Your words are in `70` §20. In short:
> open source, run by the organisation, optionally behind a hardened front door · **a vault from
> the start, and the server holds the keys, confirmed knowingly** · bench test on real SRX and
> Arista, yes · the demo runs in Docker and models no host type · people have five roles —
> read-only, write, share, invite, admin — granted per site, and a drawing is Draft, Planning or
> Production · told-plus-recorded for admin access in Draft and Planning, stricter in Production.
> Two I decided rather than asked, because you told me to: **"firewall +2" on a many-job box**, and
> **a named shelf or power strip with no power map.** One you handed back — a separate database
> for the keys — I thought about and recommend against; `70` §20.9 says why in one paragraph.
> Two lessons for me from the round: never name another product without saying "for comparison",
> and never use the word "group" for equipment when it also means people.

The questions as asked, kept for the record. Each had my recommendation so you could just say yes, or pick.

**Q1. Is this for your employer to run inside the company, or something to sell to other
companies?**
Everything you've said points to inside the company. It matters because it decides five other
questions at once: whether outsiders can sign up (no), who the contract is with (nobody), who pays
for the vendor knowledge (the employer), and which key-vault licence applies.
*My recommendation: inside the company, for now. Say if that's wrong.*

**Q2. Does your employer's IT already run HashiCorp Vault or OpenBao? If not, do they have an
AWS, Azure or Google account that security would let Fathom use? And if neither, would you run
OpenBao as one more container in the demo?**
This decides where the master key lives. Any answer works; nothing already stored would need
re-encrypting, that's designed in.
*My recommendation: whichever they already have. If nothing, OpenBao in the demo stack.*

**Q3. Can you get thirty minutes on one real Juniper SRX and one real Arista switch, or their
virtual versions?**
Four commands each. It settles whether the firmware design works on your actual boxes. Without it,
the honest label on that feature stays "not yet tested".
*My recommendation: yes, before the demo, so the answer in the room is a fact.*

**Q4. Which kind of host will actually be in the demo: Proxmox, VMware, plain Linux, Windows
Server, a NAS?**
You said you have no Proxmox box. The first host type Fathom learns should be one you can paste a
real config from.
*My recommendation: whichever you can get a config off this week.*

**Q5. Can everyone in the company see every group and tag, or do you need some private to you?**
The design shares everything. Private ones are possible but live outside the drawing and cost more.
*My recommendation: everything shared. It's a company record, not a notebook.*

**Q6. When an admin switches on "open any drawing", is it enough that the drawing's people are
told and it's permanently recorded, or must a second person approve first, every time?**
*My recommendation: told plus recorded. Two-person approval is for outside customers, later.*

**Q7. When a box does three or more jobs, is "firewall +2" on the box, with the full list one
click away, good enough?**
*My recommendation: yes. Drawing every word makes the box unreadable.*

**Q8. Is a named shelf, power strip or UPS with one word on it enough, or do you need a power
strip to know what's plugged into each outlet?**
The second is a power map, which the project has refused so far.
*My recommendation: the named thing. Power maps are a separate product.*

---

## 3. What I saw when I opened the product

I loaded your real 122-line SRX config and added two boxes by hand. Four things will hurt the
demo more than any missing feature. None is hard; all are people problems.

1. **The network map opens unreadable.** One firewall becomes 49 boxes in a tall stack at 27% zoom,
   all five layers on. Your boss's first look at the diagram is spaghetti. Defaults, not design.
2. **A VMware host gets filed as a Juniper firewall**, because platform is required and there's no
   "just a server". Anyone who knows the estate spots it on the first screen. The blank-platform
   change in §1 fixes it; do that before the demo.
3. **The findings view shows raw 26-character codes where names belong.** A policy set has the
   data to be called "trust to untrust"; it isn't.
4. **Two of six tabs say NOT BUILT on every screen.** Honest. Frame it up front: which two, and why.

And the best line in the product is in small grey type at the bottom: **"47 understood, 52 lines
not read, 8 secrets removed."** That sentence is your pitch. Make it big.

---

## 4. What I checked personally

**WO-12, the first stored row.** I traced the key-sealing design myself rather than trusting four
earlier reviews. A record moved between customers is caught. A wrong key is refused. Those two
are told apart. Deleting a customer's key really makes their data unreadable, and it's built so
code can't forget to check. Ready to build.

**One correction to something I told you this afternoon.** I said the firmware login design was
unproven on both your platforms because Juniper's copy command has nowhere to put a key. That's
true of that command. But Juniper's own files have a *different* download command that does, and a
command to generate the key on the box. I verified both. So on the SRX it's documented but
untested, which is Q3, not an open question. Arista is unchanged.

---

## 5. What can wait

Your naming scheme (state or site type before the CLLI code); whether LTE backup is its own
service; whether the fibre-access gear is the same job; whether you'll put your name on the vendor
guidance; whether Fathom may ever hold vendor firmware images. All real, none demo-blocking. Ask
me when you're ready and I'll put each as one question.
