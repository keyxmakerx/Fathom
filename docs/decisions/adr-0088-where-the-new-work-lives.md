# ADR-0088: Where the new work lives — one map of the app for seven features

**Status:** accepted 2026-11-02. The owner approved sign-off card **r88-ui-map** with the
recommended pick on all six questions (ip, teams, rail, mail, reading, phone: A) and no note.

**Covers:** the Work tab (ADR-0087, #282), teams, leads and supervisors (ADR-0081), device reading
(ADR-0082), IP management (ADR-0083), orders and the job engine (ADR-0084), email (ADR-0085) and the
AI's reach into all of them (ADR-0086). Each of those says *what*; this record says *where*, so that
the threads building them in parallel don't each pick a spot and collide.

**Keeps:** `docs/UI-SPEC.md` (the bar, one editor, the right panel's tabs, the phone layout) and
ADR-0060 decision 7 (Home's tabs, one per role). Nothing here adds a second detail pane or a view
inside the drawing.

## Decided

1. **Only Work joins the bar.** It is already there in #282, after Diagram, Canvas, Inventory and
   Sheet. Every other piece goes in a place that exists: a Home tab, the Steward list, an Admin tab,
   the device's right panel, or the account menu.

2. **Home's tabs**, each shown only to someone who holds it:
   **Designs · Work · Teams · Addresses · Passwords · Steward · Admin** (and **AI** as today for an
   AI-only maker).
   - *Teams* (ADR-0081): for someone in, leading or supervising a team. *(card: teams, A)*
   - *Addresses* (ADR-0083): the organisation's whole IP tree, for anyone who may read a block.
     Inside a design, Inventory › Addresses shows the same component narrowed to that design's
     folder. One tree, two doors, so an order can reserve before any design holds the router.
     *(card: ip, A)*

3. **The Steward list is grouped**, in this fixed order, each heading shown only when something
   under it is built *(card: rail, A)*:
   - **People:** People · *Teams* · Waiting for you
   - **Estate:** Folders · Firmware · *Device reading* (the organisation's switch and management
     ranges, ADR-0082 §4.4)
   - **Work:** *Order types* (the builder, ADR-0084 piece 5) · *Mail* (titles in mail on or off,
     ADR-0085 decision 3)
   - **Passwords and AI:** Passwords · AI · AI rules (gains *Your work* and *IP plan*, ADR-0086 §8)

   The list is data in `client/src/components/organisation/stewardRail.ts`. A thread adds its page
   by flipping its own entry's `built` and giving it a body; it never reorders another's.

4. **Admin** gains a **Mail** tab (sent, queued, failed, with the relay's reply and never the body,
   ADR-0085 decision 7). **AI** gains *Waiting for approval*, *AI apps allowed* and *AI account
   domains* (ADR-0086 §10). **Settings** shows whether device reading is on for the server
   (`FATHOM_DEVICE_READ`, read-only, since it is an environment setting).

5. **One work page for every W-number.** A plan, an It's down, a spare, an order and an order's job
   open the same page: assigned to, due, ticket, comments, AI ideas in one right-hand column.
   Orders add the stage track and the jobs; approvals add **Approve** with the signature mark;
   IP adds **Reserve** and the held block in the plan colour. These are parts of that page, never
   pages of their own.

6. **On a device:** **Read now** in the device panel's header and a **Readings** tab beside Checks,
   Plans and History, listing differences with Add or Accept, one undo step each. The first SSH
   read's host-key confirm is a dialog from Read now. The Logins list marks each login *read-only*.
   A planned-but-not-drawn address shows in the plan colour on its port. *(card: reading, A)*

7. **Your own mail settings** are in the account menu, under **Mail**: each kind at once, in the
   digest, or off, with the security mails listed as always on. *(card: mail, A)*

8. **On a phone** the bottom tabs become **Scan · Find · Canvas · Work** (plus Ideas N while an idea
   waits), and a job's page is the same work page in one column. *(card: phone, A)*

9. **Shared pieces, built once and used by every thread:** the W-number link, the person-or-team
   picker, the "signature checks" mark on anything signed, and the plan colour (indigo, ADR-0077)
   for anything planned, held or proposed. The first thread to need one builds it where the others
   can import it, and says so to the thread that owns this record.

## Numbers

Schema versions, field keys, server migrations and ADR numbers for these threads are handed out
from one ledger, kept by the thread that owns this record, so that two branches never claim the
same one. On 2026-11-02: Work tab 0.35, keys 555–561, migration 0064; IP plan 0.36, keys from 562,
migration 0065; teams migration 0066; device reading 0067 if it needs tables.

## What it gives up

- Two more Home tabs (Teams, Addresses). Each shows only to people who have it, so most people
  see one or neither. Option B on each question removes one.
- A grouped Steward list adds four headings to a list that today has seven entries.
