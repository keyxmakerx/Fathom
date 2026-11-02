# ADR-0086: What an AI connection may see and suggest in the new work

**Status:** accepted 2026-11-02 (owner, sign-off card **r86-ai-reach**: "approve", with every
recommended pick, "Mail me when an AI idea arrives" ticked as well, and a note, below). Proposed the
same day. Design only; nothing is built. Building waits on each feature it covers: nothing here is
built before the feature itself.

The owner's note on the card: "I like this idea, but do me a favor and make sure the admin can see
what AI is being used and even have the ability to sign off. I don't want an AI outside the corp to
be able to access this kinda data." Decision 10 answers it, and decision 6 takes the mail.

**Builds on:** ADR-0072 (AI access keys: a key belongs to one person, reads an allowlist, sends
ideas), ADR-0077 and its amendments (an AI proposes, a person accepts; four kinds of work at Off,
Ideas or Proposes; the admin's ceiling, the organisation's rules and the connection's own, the
strictest wins; Accept checks again).
**Covers the newly approved designs:** the Work tab (ADR-0087, #282), teams, leads and supervisors (ADR-0081, #277),
device reading (ADR-0082, #279), IP management (ADR-0083, #280), orders and the job engine
(ADR-0084, #281), email (ADR-0085, #278), and Termix in the work (ADR-0078, ADR-0080).
**Keeps, unchanged:** an AI connection never writes anything by itself. Everything below is
something it reads, or an idea or a proposal that waits for a person.

## The ask, in the owner's words (project thread, 2026-11-02)

> oh right make sure that the AI is integrated with all that please, maybe not tickets except those
> assigned to user and even then it can't do anything like with the canvas.

Read as: every new feature gets the same AI path the canvas has today (read what the key allows,
send ideas, propose a change a person accepts). Work items are the exception: an AI sees only the
ones assigned to the person whose connection it is, and on those it may only suggest.

## The one rule everything below follows

An AI connection acts for one person (ADR-0072 decision 1) and has at most that person's reach,
narrowed by the key. It may:

1. **read** what an allowlist names, at the key's tiers;
2. **send an idea**: steps in words, which a person carries out;
3. **propose**: the change itself, kept sealed, shown in the plan colour (indigo) where it would
   land, and made only when a person presses Accept, in that person's name, after Accept checks it
   again against the rules as they are then (ADR-0077, r61 amendment).

It never signs (it holds no person's key), never sends anything outside Fathom, never starts
anything that runs on its own (a device read, an engine rule, a mail, a Termix action), and never
approves.

## Decided (the recommended picks, as approved)

### 1. Work items: only those assigned to the person, and only suggestions *(card: question 1, A; question 2, A)*

A **work item** is anything with a Fathom number (`W-<n>`): a maintenance plan, an It's down
issue, a spare on order, in repair or lent, an order, and an order's job.

- **What it sees.** An AI sees a work item only while its `assigned_to` is the connection's owner
  (for a job, the person who picked it up or was assigned it). Not the team's queue, not a
  colleague's item, not an unassigned one. This is checked at every request against the live
  assignment, never cached. An item assigned away disappears from the AI's next reading.
- **This narrows ADR-0072 decision 21.** Today a design's reading carries every plan and issue in
  it. Under this record a design's reading carries only the plans and issues assigned to the
  owner; the rest are left out, as a field nobody listed is left out. A plan or issue with no
  assignee is left out too.
- **The new tool `my_work`** lists the owner's assigned items across every design and order the key
  may read: number, kind, title, state, due, design and the outside ticket link. `read_work`
  reads one, with its steps, its order's fields and its comments at the `notes` tick. Who else
  commented is shown as "a colleague", never by name (ADR-0072 decision 21 keeps names out).
- **What it may do on one.** Like the canvas: it may send an idea, or propose one of three things,
  each of which waits for the person to accept:
  - a **comment** (a note on the item, posted in the person's name, marked as drafted by AI);
  - **ticking a step** or **answering a check** (with what it would record);
  - **filling an order job's `asks`** (such as the circuit id), checked against the field's kind.
- **What it never does, not even as a proposal:** change who an item is assigned to, its due date,
  its state, its outside ticket; start, record, close, cancel or reopen it; pick up, move, send
  back or finish a job; approve or refuse anything. These stay a person's own presses.
- **Reassigned away.** Open AI ideas and proposals on an item that is reassigned to someone else
  are dismissed, in the name of the person who reassigned it, and the new assignee never sees them.
- **Drafting a new plan or issue** (ADR-0077's "drafting maintenance plans" and
  "troubleshooting") stays as it is. Accepting an AI-drafted plan assigns it to the person who
  accepted it, so the AI can go on seeing the plan it drafted.
- **A new kind of work, "Your work"**, joins ADR-0077's four, at Off, Ideas or Proposes like the
  others. The admin's ceiling for it is Proposes; a new connection gets Ideas.

### 2. Teams, leads and supervisors: names only, never membership, roles or grants

An AI may read the **name** of the team a job or queue belongs to, so it can say "this is with
Provisioning". It never reads who is in a team, who leads or supervises it, or what a team is
granted, and it never sends an idea or a proposal about any of them. Every team act in #277
decision 5 is signed by a person's key; an AI holds none, so there is nothing for it to propose.
**Approvals are never an AI's**, in any form.

### 3. Device readings: what differs from the drawing, never the raw output *(card: question 3, A)*

ADR-0082 §4.2 already says an AI may see a reading if its key allows and may propose from it, and
may not start a read. This record says what "see" is:

- **It sees the differences**: the "differs from drawing" suggestions a reading produced (an
  interface up that is drawn down, an LLDP neighbour on a port with no cable drawn, a model or
  firmware that differs), each at the tier its field is read at (`layout`, or `addresses` for
  ARP and addresses), with when it was read.
- **It never sees** the raw SNMP values or SSH output, even redacted; serial numbers (ADR-0077
  decision 4 keeps them out); MAC addresses outside what the `addresses` tick shows; the login
  used, the host key, or anything about the vault.
- **It may propose** taking a difference into the drawing, exactly as a person's Add or Accept on
  the reading would, through `propose_change`. It may send an idea whose step is "Read this
  device", which a person presses. It cannot press it, confirm a host key, or mark a login
  read-only.

### 4. IP management: read the plan, propose a reservation held in the person's name *(card: question 4, A)*

- **It reads** the plan store (ADR-0083) at the `addresses` tick, only the blocks whose folder the
  key may read (a block with no folder needs the key's "every folder"): aggregates, prefixes,
  ranges, reservations (holder shown as "you" or "a colleague"), VRFs, VLAN groups, ASN ranges,
  route targets, and the difference checks. DNS names and NAT pairs are at the `notes` tick.
- **`next_free`** answers "what would the next free /29 be" and holds nothing. It is a reading,
  so two AIs asking get the same answer and neither has it.
- **It may propose a reservation**: a block, a size, a reason and an end date (30 days unless it
  says less). Nothing is held until the person accepts. Accept allocates under ADR-0083
  decision 5's lock with the allocation key `ai:<idea id>`, so a second press returns the same
  block, and the next free is worked out again then, not taken from the proposal. The
  reservation's holder is the person who accepted it. The person must have Draw on the block's
  folder, as for their own reservation.
- **It may propose Adopt** on a "configured but not planned" check, which makes a plan record.
- **Steward-only parts are ideas only**: making or changing aggregates, VRFs, VLAN groups, ASN
  ranges and route targets, and releasing someone else's reservation. An AI may suggest them in
  words to a Steward; it never proposes them.
- **A new kind of work, "IP plan"**, at Off, Ideas or Proposes. The admin's ceiling is Proposes; a
  new connection gets Ideas.

### 5. Orders and the job engine *(card: question 5, A)*

- **Orders are work items** (decision 1): an AI sees an order only through a job assigned to the
  owner, and then the order's fields and stage track, not other teams' jobs beyond their name,
  stage and state.
- **The engine never acts for an AI.** No AI idea or proposal counts as a job move; an `overdue`
  rule (ADR-0084 decision 11) fires on the clock, never because an AI asked. An accepted AI
  proposal is the person's own act and the engine sees it as theirs.
- **Order types: an AI may draft one.** A Steward's connection may send an idea carrying a whole
  order definition file (ADR-0084 decision 1). It is never installed by the idea: the Steward
  presses **Open in the builder**, which runs the same check, preview and team matching as
  importing a file (ADR-0084 decision 7). A definition is data, not code (decision 2 there), so a
  drafted file can do nothing a hand-written one could not. Only connections whose owner is a
  Steward of the organisation see this.

### 6. Email: an AI never sends one; one mail tells the person an idea is waiting

An AI never sends a mail, never chooses a recipient and is never one. When a person accepts an AI
proposal, the mails ADR-0085 already sends for that act (work assigned, done and so on) go as for
any act of theirs.

**Amended on acceptance (the owner ticked "Mail me when an AI idea arrives"):** a seventh kind of
mail, **An AI idea is waiting on your work**, goes to the connection's owner, and only to them, when
an idea or proposal arrives on a work item assigned to them. Like ADR-0085's six it carries a link
into Fathom and never the AI's words, the item's text or anything the AI wrote. It is on by default
and the person turns it off with the others in their mail settings. Because a connection may send
300 ideas a day, it is gathered: at most one such mail an hour per person, naming how many ideas
are waiting. Ideas on the canvas, outside the Work tab, send no mail.

### 7. Termix: nothing

An AI never opens a terminal, adds a host to Termix, sends a snippet, or starts or ends a Termix
maintenance window (ADR-0080 decisions 2, 4, 6). It may propose plan steps whose commands a person
later sends to Termix with **Send to Termix**, as a person would write them. The Termix key in the
browser's `sessionStorage` (ADR-0078) never reaches the server, so no AI path can reach it.

### 8. How the settings look

Organisation › AI rules and Admin › AI gain the two new kinds, **Your work** and **IP plan**, beside
ADR-0077's four, with the same three levels and the strictest of the three places winning. "Order
types" is not a separate kind: it follows the Steward's own "Editing the design" level, and is
ideas only. Device readings follow the tiers, not a kind. Teams, approvals, email and Termix have no
setting, because there is nothing to turn on.

### 9. Tools

New on `/mcp` and on the helper, each listed only to a connection that may use it, and each
re-checking the assignment, folder and tier at every call:

| Tool | Reads or proposes |
|---|---|
| `my_work` | lists the owner's assigned work items |
| `read_work` | one assigned item |
| `suggest_on_work` | an idea, or one of decision 1's three proposals, on an assigned item |
| `read_ip_plan` | blocks under a folder, with their checks |
| `next_free` | the next free address, prefix, VLAN ID or ASN, holding nothing |
| `propose_reservation` | a reservation or an Adopt, waiting for the person |
| `read_design` | gains `readings`: decision 3's differences |

`whoami` lists the new kinds and their levels. Limits are ADR-0077's: every new proposal counts
toward the connection's 10 a minute and 300 a day. Every string an AI sends passes the server's
credential check (ADR-0077 decision 9), including comments, step answers and a drafted order
definition, whose text also goes through the gate when the builder opens it.

### 10. The admin sees which AI is used and signs off each connection

Added on acceptance, for the owner's note. ADR-0072 decision 9 already gives the admin (Admin › AI,
the operator plane) every key and connection on the server with its label, person, organisation,
when it was made and last used and from where, and the AI account the person named (decision 24),
with Disable. This adds:

- **What it is.** Each row shows the app (Claude, Claude Code, or another app by its redirect's
  host, ADR-0072 decision 16), its kinds of work at their levels, and whether it reaches the new
  parts: **Your work**, **IP plan**, device readings.
- **Sign-off.** A server-wide setting, **New AI connections wait for an admin**, on by default. A
  connection a person allows, or a key they make, does nothing until an admin approves it in Admin ›
  AI: every request before then is refused with "waiting for your admin". Approve releases what the
  organisation and the person already chose; it widens nothing, so ADR-0072 decision 9's "an admin
  grants nothing" stands in substance, and is reopened only so far as an admin may now hold a
  connection back as well as stop it (CLAUDE.md rule 6, the owner's words). Widening a connection's
  tiers or kinds later sends it back to waiting. The person and the organisation's Stewards are told
  when it is approved or refused. Connections that exist before this is built wait once.
- **Only the company's AI.** Admin › AI gains two server-wide lists, both narrowing only:
  **AI apps allowed on this server** (Claude, Claude Code, other apps; an organisation's policy,
  ADR-0072 decision 16, cannot allow an app the server does not), and **AI account domains**, for
  example `corp.example`. With a domain listed, the AI account a person names (ADR-0072 decision 24)
  must end in one of them, or Allow and Make key refuse. A Claude connection stays held to
  Anthropic's published range (ADR-0072 decision 17).
- **What this cannot prove, said plainly.** Fathom still cannot check which Claude account is really
  signed in (ADR-0072 decision 23): a person could name the company address and use a personal
  account. The admin's sign-off is the defence: they approve a connection knowing the person, and
  can stop it. The check that would prove the account, Enterprise Managed Auth, is card
  r42-ai-account, approved for after beta; when it is built, the domain list becomes a hard check
  against the signed-in account rather than the stated one.

## Rejected

- **The AI sees the team's queue too** (card question 1, B). Its strongest argument: an assistant
  that could say "three jobs in your team's queue are overdue" is useful to a lead. Rejected
  because the owner said "except those assigned to user", and a queue is where other people's
  work and comments sit, which is where an injected instruction would come from.
- **Keep ADR-0072 decision 21 as it is**, every plan and issue in a readable design (card question
  1, C). Rejected because it lets an AI read work assigned to someone else as part of a design,
  which is what the owner ruled out.
- **Ideas only on work items, no proposals** (card question 2, B). Its strongest argument: "it can't
  do anything" read literally. Rejected for the recommendation because the owner added "like with
  the canvas", and on the canvas an AI may propose what a person accepts; the three proposals are
  each a thing the person reads and presses.
- **The AI may start a device read.** Rejected by ADR-0082 already: a read is started by a person.
- **The AI may reserve addresses directly**, so an order is not raced. Rejected: a held block is a
  change, and a proposal that waits holds nothing.

## What this does not protect against

- **Text in an assigned item can still steer the AI.** A comment a colleague wrote on the
  person's own item is read. The person's Accept is the defence, as on the canvas, and the AI
  cannot do the things that would matter most (reassign, approve, close).
- **The AI's draft comment is posted in the person's name.** It is marked as drafted by AI, and
  the person accepted it, but a reader of the comment trusts the person.
- **`next_free` tells an AI where free space is** in folders the key reads. That is the same as
  reading the tree, which the `addresses` tick already allows.

## Built with each feature, not before

Each piece lands in the same PR series as its feature, after that feature's own security sweep:
decision 1 with the Work tab's next step (the reading narrowing first, since the Work tab is
already built in #282); 2 with teams; 3 with ADR-0082's SNMP piece; 4 with ADR-0083's store; 5 with
ADR-0084's engine; 6's seventh mail with the Work tab's mail; 7 needs no code beyond tests that
the path does not exist; 10 first, before any of the others, since it guards the data they open.
