# Fathom — Rebuild Plan

**Status:** Draft, 2026-09-11
**Supersedes:** `00-ROUTE-TO-WORKABLE.md` and `00-PROGRAM-PLAN.md` as the operative plan.

---

## Why we are doing this

Three things went wrong, and none of them is that the work was bad.

1. **The product changed and the client didn't.** On 2026-08-18 we decided the data lives on a
   server and the browser is just a window onto it. The browser side was never rebuilt to match,
   so it still carries an architecture we retired three weeks ago.
2. **Everything on screen was hand-built.** Dragging boxes, drawing lines, zoom, the diagram
   layout — all written from scratch. Each one took weeks and its own round of testing. Ready-made
   tools for this exist and are better than what we wrote.
3. **Running the project got expensive.** The notes file is read before every single instruction,
   and it has grown into a changelog. Most of what we spent was paid before any work started.

The engine is fine. The thinking is fine. The problem is the layer people see and the cost of
touching it.

---

## What we are keeping

| Kept | Why |
|---|---|
| The whole Rust engine — schema, graph, config reading, redaction | Hard, correct, tested. Nothing to replace it. |
| The server | Already runs, already proved against a real database. |
| The redaction gate | Passwords are protected by never arriving. That stays. |
| Key handling (ADR-0040) | Already decided and ratified. |
| The reasoning in the docs | Moved to an archive, not deleted. |

## What we are replacing

| Replaced | With |
|---|---|
| The single offline HTML file | A proper web app talking to the server |
| The hand-written diagram | A ready-made diagram tool |
| The hand-written layout engine | A standard layout algorithm |
| A notes file that costs money to read | A short pointer page plus an archive |

**Nothing needs migrating.** There is no stored data anywhere, so we are free to change
everything about how things are stored.

---

## The stack

Decided. Not reopening without a reason.

**Engine and server — Rust.** Unchanged. This is where speed actually matters.

**Screen — React with Vite, plain CSS.** Checked September 2026: no framework is being abandoned
or rewritten, nothing new has broken through, and React is the least likely of any option to
disappear. Rust-for-the-screen was considered and rejected — there is no mature diagram tool for
it, so we would hand-build the canvas again, which is the mistake we are correcting.

**Diagram — React Flow.** Purpose-built for exactly this: draggable boxes, lines between them,
pan and zoom, thousands of nodes. Replaces months of our own code.

**Storage — PostgreSQL 19 (beta now, GA when it ships), encrypted, with a tamper-evident history.**
Checked September 2026: the "Postgres needs cleaning yearly" concern is dated — modern versions
handle it automatically. Every alternative was worse here: SQLite serialises writers, MariaDB lacks
tenant isolation, CockroachDB retired its free self-hosted tier (a licensing trap when customers run
it), and no graph database survives scrutiny — Kuzu was bought by Apple and archived, its forks are
unproven, CozoDB has an unresolved data-corruption report, and the rest carry restrictive licences.
Develop against 19 beta; pin GA before any real data exists. Every change is recorded in a
chain where each entry is sealed against the one before it. Alter any past entry and the chain
visibly breaks. That is the useful half of what blockchain offers, without running a chain.

**No Tailwind.** Plain CSS suits our existing colour system better.

### Version policy

**Take the latest stable release of everything.** Owner decision, 2026-09-11, overruling a
recommendation to apply the existing seven-day cooldown to web packages. The reasoning: nothing is
in production, no data exists anywhere, and versions pinned at the start of a rebuild are stale by
the time it ships.

Two things hold regardless:

- **Install with scripts disabled** (`npm ci --ignore-scripts`). The danger in a fresh package is
  code that runs during installation, which is how the August 2026 attack worked. Disabling it
  costs nothing and removes the reason the cooldown existed.
- **The Rust cooldown gate is unchanged.** This decision covers web packages only.

**Revisit trigger:** before the first release to anyone who is not the owner, run a full
vulnerability check across every dependency and record what it finds.

---

## Owner decisions, 2026-09-11

Three answers that change the shape of the work.

### 1. What the product is for — reordered

**Drawing comes first, not parsing.** The priority order is now:

1. **Drag-and-drop diagramming**, the way Lucidchart does it. This is the product.
2. **Teaching and learning**, including a configuration checker that explains *dynamically why
   something is failing* — not just that it is.
3. **Inventory.**
4. Monitoring and integration with live systems. **Beyond alpha and beta.** Noted, not scheduled.

**Pasting a config is no longer a core feature.** Keep it only because it already exists and costs
little to carry.

**What this changes, and it is not small:** the parsing pipeline was built to construct an estate
from pasted configs. That is no longer its job. But it is not wasted — **it is the foundation of
priority 2.** A configuration checker that explains why a config fails needs exactly what ingest
already does: read the config, understand its structure, and know what it means. The work moves
from *building the drawing* to *explaining the config*. Keep all of it.

The schema's role changes too. It was the vocabulary for parsed estates; it is now the vocabulary
for things people draw by hand. Same schema, different primary caller.

### 2. Live collaboration — scoped, not global

Real-time, with cursors, **but scoped to what you are looking at.**

The estate is a hierarchy: organisation → network → building → rack. Two people in the same rack
elevation see each other's cursors live. Two people in different racks — or different networks —
do not know the other is there at all.

This is a better design than broadcasting everything, and cheaper to build: presence follows the
view, so the traffic is proportional to how many people share a scope, not to the size of the
estate.

A chat system is wanted eventually. Not now.

### 3. Hosting — Docker, and security is the headline requirement

Fathom ships as Docker containers. **The old decision saying Fathom would never run accounts or a
service is retired** — there are accounts, there is a server, there is stored data.

"Incredibly secure" is the stated bar. What that means concretely is in the storage section above
and gets its own hard review in Phase 2.

---

## Phases

### Phase 0 — Cut the running cost

The notes file is read before every instruction. Shrinking it makes every phase after this one
cheaper, so it goes first.

- Cut the main notes file to a short pointer page — what this is, the rules that bind, where to
  look. Not a changelog.
- Create one current-state page, read only when needed.
- Move the existing corpus into an archive with a standing rule: *do not read unless a task names
  a specific file.*
- Give each helper a restricted toolset so it cannot wander through the archive.

**Done when:** a fresh session costs a fraction of what it does today, and nothing has been lost.

### Phase 1 — Take stock

One pass to establish what is actually built versus what is only written down. We know from
experience this list will be shorter than the documents suggest — a previous sweep found nearly
half of all flagged items were already stale.

Also: what Homelable (the reference project) solves that we should adopt rather than invent.

**Done when:** one page says what exists, what is stale, and what order to rebuild in.

### Phase 2 — Foundation

The stocktake found the two halves of this codebase are not connected at all: the server compiles
against no Fathom crate. That gets fixed first, because nothing else can be saved until it is.

- Wire the server to the engine — graph, schema, identifiers.
- Database tables, encryption, and the tamper-evident change history.
- **The credential vault (ADR-0042).** Separate storage, separate keys, tokens in the design.
  Built in Phase 2 because retrofitting a vault into a live schema is the kind of migration this
  project exists to avoid.
- Accounts, organisations, and the scope hierarchy (organisation → network → building → rack),
  because live presence is scoped to it and retrofitting a hierarchy is expensive.
- The endpoints the client needs to open, change and save a design.

**Security gets a hard adversarial review in this phase.** It is the stated bar and the one thing
here that is expensive to fix later.

**Done when:** the server stores a design, hands it back, and the history verifies as unaltered.

### Phase 3 — The canvas

**This is the product.** Drag-and-drop diagramming, the way Lucidchart does it.

**The design is settled: `docs/UI-SPEC.md`, approved 2026-09-11.** Rack-first — the rack, its
faceplates, its ports and the cables between them are the product. Build against that page; open the
picture canvas only when building the surface it shows.

- New web app talking to the server.
- Our existing look — colours, typography.
- Canvas with the ready-made diagram tool: drag boxes from a palette, drop them, connect them,
  move them, pan and zoom.
- The gestures already proven in the old client, reimplemented properly: place, link, cable,
  drag-to-connect.

**Done when:** you can build a network diagram from nothing, by dragging, and it saves.

### Phase 4 — Working together

Scoped live presence: cursors and live changes for people in the same view, invisible across
different ones.

**Done when:** two browsers in the same rack see each other, and two in different racks do not.

### Phase 5 — Inventory

The table of everything, editable in place.

### Phase 6 — Teaching and the config checker

The second priority, and the largest genuinely new design in the project.

- **Learning mode** — the teaching half, a stated goal since the beginning with no mechanism
  behind it.
- **A configuration checker that explains why something fails.** Not a pass/fail. It should say
  *which* line, *why* it does not do what was intended, and what the device will actually do.

This is where the existing parsing work gets its second life. It was built to construct estates
from configs; it is better used explaining them.

**Design comes before building here.** Neither has ever been specified properly.

### Later — beyond alpha and beta

Monitoring live systems, and integrating securely with them. Recorded so it is not designed out,
not scheduled.

---

## Who does the work

Roles, not running processes. Each is spawned only when needed.
**Defined in `.claude/agents/` — one file each, carrying the model and effort level for that
role.** Lead is this session; it has no file.

| Role | Used for |
|---|---|
| Lead | Holds the plan, decides, delegates. |
| Builder | Does the work, one task at a time. |
| Checker | Attacks the work independently. Never shares the builder's context. |
| Bookkeeper | Re-checks numbers and corrects documents. Cheap. |
| Security | Anything touching credentials, encryption or dependencies. |
| Designer | Draws a screen from a closed brief. Expensive, so used narrowly. |

**Rule:** helpers coordinate with each other about the work. They do not renegotiate the plan.
Decisions come back to the lead.

For adversarial review — several independent checkers attacking the same thing — a scripted run
is used instead, because helpers cannot spawn their own helpers.

---

## Rules that keep this cheap

1. Never read the archive unless a task names a file in it.
2. Cheap helpers read; expensive ones decide.
3. Ask a closed question, get a short answer. No open-ended exploration.
4. The notes file is a pointer page. If it starts becoming a changelog again, cut it.
5. One task at a time unless two are genuinely independent.
6. **Never `git add -A` while a helper is working.** It sweeps that helper's half-written files into
   whatever the lead is committing, and the commit message then describes none of it. Done once on
   2026-09-12: a dependency change landed in a commit about a documentation number. Stage explicit
   paths.

---

## Open questions

Answered 2026-09-11: live editing (scoped, real-time), hosting (Docker, accounts, secure),
discovery (not now — drawing first).

Still open:

- Does the first release keep an audit log?
- Key custody for a customer with no cloud.
- **Within one scope, what happens when two people change the same device at the same instant?**
  Scoped presence answers who sees whom; it does not answer who wins. Needed before Phase 4.
- Whether pasting a config survives at all once the checker exists, or whether the checker
  becomes the only reason to paste.

---

## Deliberately not decided here

Anything in `docs/OPEN-QUESTIONS.md` that this plan does not touch. That page remains
the register of owner decisions, and this plan does not answer any of them on the owner's behalf.
