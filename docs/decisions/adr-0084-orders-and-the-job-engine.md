# ADR-0084: Orders and the job engine — order definitions in YAML, and a builder on a canvas

**Status:** accepted 2026-11-02. The owner approved sign-off card `orders-engine` with every
radio pick A (stages with `needs` and `send_back`; describe-only files; board and file both ways;
open orders keep their version; Stewards make order types), ticked the three recommended extras
plus "more starters" and "overdue jobs move on or reassign by themselves", and wrote: *"Overdue
orders based on types and such CAN move. Also i want the IP stuff, and the engine ... before we
release."* Decision 11 is the overdue answer; decision 12 the starters; decision 13 the release
gate. Nothing is built.

**Comes from:** sign-off card r75-work-plan, approved 2026-11-02 with every pick A, piece 7 ("Orders
and jobs"), and the owner's note on it: *"we'll probably need a job engine, can you make it yaml
based or something a modder could easily look at PLUS have a user friendly interface for users who
are like me and not good at coding. Maybe even a canvas style drag and drop tool to go in order of
things dynamically."* Before that, r74: orders with types such as DIA that go through Order
Management, Design, Provisioning and Installation, one team each, with the order carrying its IP
breakdown.

**Builds on:** ADR-0062 (organisation-wide definitions are server records, not graph nodes; custom
fields are the precedent), the Work tab (r74, r75 piece 4: every piece of work has a Fathom number
and may link to an outside ticket), maintenance plans (schema 0.15, `MaintenancePlan` and
`PlanStep`), ADR-0063 (live changes), the corpus (`corpus/`, authored YAML read by Fathom).

**Leaves open, on purpose:** who a job's team is (ADR-0081, teams and permissions, not yet
answered) and how an order reserves addresses (ADR-0083, IP management, not yet answered). This
record names the hook each one plugs into and decides nothing about either.

## Context

Today Fathom has three kinds of work: maintenance plans and It's down issues inside a design, and
spares on order or away in Inventory. None of them is a process that several people or teams carry
out in turn. An order for a Dedicated Internet Access circuit is exactly that: someone takes the
order, someone designs it and picks addresses, someone configures the edge router, someone installs
the hand-off at the customer's site, and each one waits for some of the others.

Every organisation runs that process a little differently, and changes it. If the stages are code,
every change is a Fathom release. So the process has to be data, and the owner asked for that data to
be two things at once: text a modder can read and diff, and a picture a non-coder can drag.

## Decided

1. **An order type is an order definition: one YAML document.** It names the order's fields (what
   is asked when the order is opened), its stages in order, and the jobs in each stage. In code and
   in the store it is an *order definition* (`OrderDefinition`), because `.context/conventions.md`
   gives "type" away; on screen it is an "order type", the owner's words. Fathom ships starter
   definitions under `corpus/orders/` (DIA first); an organisation's own live as server records,
   ADR-0062's precedent, edited by a Steward. A Steward starts from a starter, a blank one, or an
   imported file.

2. **The YAML only describes; it never runs anything.** A definition has a fixed set of keys, each
   checked when it is saved. There are no expressions, scripts, templates, hooks or URLs that Fathom
   fetches. A condition is one structured comparison from a short list (`is`, `is_not`, `in`, `at_least`,
   `at_most`, `set`, `not_set`) on one of the order's own fields, or `all` / `any` of those. An unknown key is
   refused, not ignored, so a typo shows rather than silently dropping a step. The reason: a
   definition will be shared between organisations, and anything that executes would make an
   imported file a way in. Every text in a definition goes through the redaction gate like a note.

3. **Order of work: stages in order, jobs side by side inside a stage, and `needs` across them.**
   A stage starts when the one before it is done. Its jobs run at the same time unless a job names
   others it `needs`. A job may `send_back` to an earlier stage with a reason (Installation finds
   the port is wrong; the order returns to Design). That covers "go in order of things dynamically"
   without a free flowchart, which is easier to draw wrong than to read. Saving refuses a cycle, a
   `needs` that names nothing, or a job left unreachable.

4. **A job is a small checklist with a team and a result.** Each job has a name, a `team` (decision
   8), optional `steps` ticked one by one, optional `asks` (order fields this job fills in, such as
   the circuit id), optional `when` (the job only exists for orders that match), optional `due`
   (a duration from when the job becomes ready; an overdue job is marked, and moves only by an `overdue` rule, decision 11), optional `optional: true`, and
   optional `makes: plan` (opens a maintenance plan in a chosen design, and the job is done when
   the plan is recorded). Troubleshooting is not planned work, so `makes: issue` is not offered.
   A job's result is Done, Sent back (with a reason) or Cancelled (with a reason). A stage may say
   `approval: lead` or `approval: overseer`; it is then done only when such a person signs it off,
   and nobody approves their own work (ADR-0081).

5. **The builder is a canvas over the same YAML, and either side can be edited.** Stages are columns,
   jobs are cards dragged within and between them, a `needs` is an arrow drawn from one card to
   another, and a `send_back` is a dashed arrow leftwards. Selecting a card opens its details in the
   right panel, the same panel the diagram uses. A YAML tab shows the text beside the canvas, and an
   edit on either side redraws the other; a YAML edit that does not pass decision 2's check shows the
   error on the line and leaves the canvas as it was. React Flow draws it, as it draws the diagram.

6. **An open order keeps the definition it started with.** A definition has versions. Saving makes a
   new one; orders already open carry on with theirs and say so. A Steward can move one open order
   onto the new version, and Fathom shows which jobs that adds or drops before it does. Nothing moves
   by itself.

7. **Sharing is a file.** A definition exports as one `.yaml` file and imports from one. Import shows
   the canvas and the check's result before anything is saved, and the Steward maps each team slug to
   a team of theirs (decision 8). There is no online library and no signing yet; rule packs'
   signing (conventions: "a signed, versioned bundle") is the model if one is wanted later.

8. **Teams: a slug in the file, a team id once installed — the rest is ADR-0081's.** A job names its
   team by slug (`team: network-design`: lowercase letters, digits and hyphens, ADR-0081's form). On
   install the Steward matches each slug to a team, or creates one, and the installed version stores
   the team's fixed id, so renaming a slug later breaks nothing. A slug left unmatched blocks the
   install and is listed. Who leads a team, who may pick up, assign or move a job, and who sees an
   order are ADR-0081's; the role over several teams is `overseer` in code and "Supervisor" on
   screen, because conventions give "supervisor" to the AI layer. This record requires only that a
   job is given to exactly one team.

9. **Addresses: a field kind that asks for a block — the rest waits for ADR-0083.** An order field of
   kind `prefix` (with a family and a size, such as IPv4 /29) is what a job `reserves`. What reserving
   means, where the reservation lives, how "next free" is chosen and how it ties to the drawing are
   ADR-0083's. Until it is answered, the field is a typed prefix with no reservation behind it.

10. **The engine is a small state machine on the server, recorded in the sealed history.** An order is
    a piece of work on the Work tab with a Fathom number (W-…) and an optional outside ticket link,
    as r75 approved. The engine moves a job from Waiting to Ready when its stage starts and its
    `needs` are done, and records every move, tick, answer and result with who and when, in the same
    tamper-evident history as other changes. It never touches a device, never sends anything by
    itself (email is ADR-0085's), and never changes a design except through a plan a person applies.

11. **Overdue work may move, when the order type says so.** The owner's answer on the card: a
    definition may give a job an `overdue` rule, and the engine carries it out by itself when the
    job's `due` passes. The rule is declared in the file, so a person reading the order type sees
    exactly what will happen; with no rule, overdue is only a mark, as before. The moves, from a
    fixed list like decision 2's comparisons:
    - `escalate: lead` or `escalate: overseer` puts the job in front of that role (ADR-0081) as
      well as the team, marked overdue;
    - `reassign: team` takes it off the person who picked it up and back to the team's queue;
    - `reassign: <team-slug>` hands it to another team (mapped at install like any slug);
    - `move_on` finishes the job as Skipped, overdue, so the stage can carry on. Allowed only on a
      job marked `optional: true`, and never past an `approval`: a stage that needs a sign-off
      waits for a person, whatever the clock says.
    Rules may chain (`after: 1d, escalate: lead`, then `after: 3d, reassign: team`). Every automatic
    move is recorded in the sealed history as the engine's, with the rule that fired and the
    definition version, and is shown on the order. An automatic move never touches a device or a
    design, never closes an order and never cancels one. Telling people about it is ADR-0085's.
    The clock runs on the server, checked once a minute; a server that was down catches up when it
    starts, firing each rule once, in order.

12. **Starters: DIA, a new site build, and taking a service out.** All three ship under
    `corpus/orders/` as files to copy, not as live types. DIA is written now (above). The other two
    are drafted from general practice and marked as drafts until checked against one real order of
    the owner's, so they don't encode guesses as process.

13. **Orders, the engine and IP management ship together, before release.** The owner wants the IP
    work (ADR-0083) and this engine in the release, so `reserves` is built against ADR-0083's store,
    not left as a typed prefix (decision 9 becomes the interim state of the build, not of the
    release). A definition file is read with the project's own YAML subset parser
    (`crates/fathom-schema/src/subset.rs`, `62` §2.2), so no YAML crate is added; flow maps stay on
    one line, as the example below does.

## A definition, as a modder sees it

```yaml
fathom: order-definition/1
id: dia
name: Dedicated Internet Access
number: DIA        # orders show as W-1042 · DIA

fields:
  - { key: customer,  label: Customer,  kind: text,   required: true }
  - { key: site,      label: Site,      kind: site,   required: true }
  - { key: bandwidth, label: Bandwidth, kind: choice, choices: [100M, 1G, 10G], required: true }
  - { key: circuit,   label: Circuit id, kind: text }
  - { key: wan_v4,    label: WAN block, kind: prefix, family: ipv4, size: 29 }   # ADR-0083

stages:
  - id: order
    name: Order Management
    jobs:
      - id: check
        name: Check the order
        team: order-desk                          # ADR-0081
        steps: [Customer contact confirmed, Site address confirmed, Contract signed]
        due: 1d
        overdue:
          - { after: 0d, escalate: lead }
          - { after: 2d, reassign: team }

  - id: design
    name: Design
    approval: lead                                # a team lead signs the design off
    jobs:
      - id: addresses
        name: Reserve the WAN block
        team: ip-design
        reserves: wan_v4
      - id: port
        name: Pick the edge port
        team: network-design
        when: { field: bandwidth, in: [1G, 10G] }
        steps: [Port with a free 10G optic chosen]

  - id: provision
    name: Provisioning
    jobs:
      - id: configure
        name: Configure the edge router
        team: provisioning
        needs: [addresses, port]
        makes: plan
        asks: [circuit]

  - id: install
    name: Installation
    jobs:
      - id: handoff
        name: Install the hand-off
        team: field
        steps: [Fibre patched, Light levels in range, Customer can reach the gateway]
        send_back: { to: design, label: Port is wrong }
```

## Rejected

- **A free flowchart (any box to any box).** Its strongest argument: some processes really do branch
  and rejoin, and a flowchart draws that directly. Rejected for now because stages, `needs`, `when`
  and `send_back` cover every order in r74, and a free graph is the shape non-coders most often draw
  wrong. It can be added later as a stage that holds a sub-graph, without changing existing files.
- **A small expression language or scripts in the YAML.** Its strongest argument: modders will want
  to compute things (a due date from bandwidth, a field from two others). Rejected because it turns
  every imported file into code that runs on the server, which this project's security rules would
  then have to review per file. Decision 2's list can grow one comparison at a time.
- **Definitions in the design graph.** Rejected for ADR-0062's reason: an order type belongs to the
  organisation, not to one site's drawing, and an order spans designs.
- **Overdue as a mark only.** Recommended on the card and overruled by the owner: some order types
  need work to move without a person. Decision 11 keeps what the recommendation protected (no
  surprise moves, no skipped sign-offs) by making every move declared, listed and recorded.
- **Moving open orders onto a new version automatically.** Rejected because a job a team is halfway
  through could vanish under them.

## Building it

Six pieces, one PR each, in this order. None starts before the Work tab (r75 piece 4) is on main,
because an order is a piece of work there.

1. **The definition and its check** (Rust, no UI): read a file through the subset parser, refuse
   unknown keys, cycles, dangling `needs`, unreachable jobs, `move_on` without `optional`, and
   unmatched slugs at install; versioned server records per organisation, sealed like custom field
   definitions. Starters under `corpus/orders/`. A CLI `check` reuses it later if wanted.
2. **The engine**: orders and jobs as server records, the Waiting → Ready → Done / Sent back /
   Cancelled machine, `when`, `needs`, `send_back`, stage `approval` (ADR-0081's roles, no
   self-approval), every move sealed. Needs ADR-0081 built.
3. **The overdue clock** (decision 11): the once-a-minute check, catch-up on start, the escalate /
   reassign / move_on moves, each sealed as the engine's.
4. **Orders on the Work tab and a phone**: open an order from a type, its page (stage track, jobs,
   asks, ticks, sign-offs), `makes: plan` opening a maintenance plan, the W- number and ticket link.
5. **The builder**: Steward › Order types, the React Flow board (stages as columns, jobs as cards,
   arrows for `needs`, dashed `send_back`), the File tab both ways, live check, versions, export and
   import with team matching.
6. **Addresses**: `reserves` against ADR-0083's store. Needs ADR-0083 built.

Rough size: pieces 1 and 3 are small, 2 and 4 medium, 5 the largest (most of it client), 6 depends
on ADR-0083's shape. No new external dependency is expected: the YAML subset parser exists, and
React Flow is already the diagram's.

## What would change this

An answer on ADR-0081 or ADR-0083 that cannot be expressed as "a job has one team" or "a field asks
for a prefix that a job reserves". A starter definition beyond DIA that stages, `needs`, `when` and
`send_back` cannot describe.
