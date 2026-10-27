# ADR-0077: An AI connection may change a design, when the organisation and the person both say so

**Status:** proposed 2026-10-27. The owner approved sign-off card r41-ai-write, option B ("A 'May
change designs' tick on a connection, off by default"), and answered its question in a note:
"So to clarify this is per user and per org, or only per org? I was thinking both". Both it is.
Steps 1 to 3 below are built (migrations 0050 and 0051, `src/ai_change.rs`) and the sweep is
done (below). Nothing merges until the owner says so. A security sweep follows the build, and
nothing merges before it.

**Reopens** ADR-0072 decision 2 ("read and recommend only") on merit (CLAUDE.md rule 6), for
connections that are given this power and no others. **Keeps** ADR-0063 (a change is one batch the
server applies and orders), ADR-0049 §2 and rule 4 (the server refuses a credential in anything
stored), and ADR-0072's grant, policy, ceiling and three people who can stop a connection.

## Amended 27 October 2026: an AI proposes, a person accepts

The owner, the same day: "Just to confirm the AI shouldn't be able to push directly, it would look
like the planner that was already there (though it should show you with purple or whatever color we
went with) of what it is going to do, other colors can be there like if deleted something, or if
that'll just be greyed out, anyways doesn't matter, like the user still has to accept the changes".

So an AI connection never writes to a design. What decisions 1 to 9 describe as a change it makes is
now a change it **proposes**:

- `POST /ai/v1/designs/{d}/changes` (the Claude tool, now named `propose_change`, and the helper's
  `fathom_propose_change`) checks the operations exactly as before (the allowlist, the version read,
  20 removals, 200 operations, the gate on every string, the owner able to draw there) and keeps them
  sealed in an AI idea. Nothing in the design moves. `recommend` may carry the same change.
- The two ticks now say "may propose changes". A connection without both may still send ideas of
  steps only. `whoami` says `readOnly: true` for every connection.
- The idea lists what the change touches (`preview`: what it changes, removes, adds and links). The
  ideas panel's **Show on canvas** draws it as an open plan is drawn, in the plan colour (indigo),
  tagged AI CHANGES, AI REMOVES or AI ADDS, with removals greyed and the rest faded.
- **Accept and apply** makes it on the design as it is then, as the accepting person's own edit, in
  their name; History shows it as theirs. A folder that needs a second person still needs one.
- The limits count proposals: 10 a minute and 300 a day per connection, from the ideas it sent.
- `ai_design_changes` keeps the rows written before this amendment; nothing new is written to it.

## Amended 27 October 2026: what an AI may do, set by kind of work

The owner asked that "admin can control what it can and can't do, if it's planning only, or
maintenance, or troubleshooting, or editing, or if it needs to sign off each change independently
... stewards get similar rules ... not too finely grained", and approved sign-off card
r47-ai-controls the same day with "three levels | kinds of work | admin ceiling | folder rules |
limits | show settings | work through plans | per field". Migration 0056.

- **Four kinds of work, three levels.** Editing the design (everything not below), drafting
  maintenance plans (`MaintenancePlan`, `PlanStep`, `HasStep`), troubleshooting (`Issue`,
  `IssueStep`, `HasIssueStep`), and working through a plan (a plan's stage, outcome and record, a
  step's state, done-at, before and after, an issue's stage and outcome). Each is Off, Ideas (steps a
  person carries out) or Proposes (the change itself, which waits for a person to accept it, as
  above). Fields set on something the same change adds count as adding it.
- **Three places, the strictest wins** at every request: the admin's ceiling (Admin › AI;
  `ai_site_switch.work`; by default Proposes for all but working through a plan, which is Off), the
  organisation's (Steward › AI rules; `ai_policies.work`, refused above the ceiling), and the
  connection's own (`ai_keys.work`; its owner raises or lowers it, a Steward only lowers it). A new
  connection ticked "May propose changes" follows whatever the organisation allows; unticked, Ideas.
  Rows from before keep their tick: ticked reads as Proposes, unticked as Ideas, working through a
  plan Off. The old ticks are now "any kind at Proposes".
- **Folder rules.** A Steward marks folders ideas-only (an AI sends steps there, never a change) and
  folders an AI does not see at all (never listed, never read). A folder counts with what it holds.
- **Only these kinds and fields.** An optional list, `Device` or `Device.hostname`, at most 100: a
  kind lets an AI add, remove and set it; a kind and field lets it set that field only. Empty is
  everything the reading allows.
- **Limits.** A Steward may lower proposals a minute (at most 10), a day (at most 300) and removals in
  one proposal (at most 20). Past one, the answer is 429 with when to try again.
- Accept and apply is not narrowed again: the change was checked against the rules when it was sent,
  and a person accepting it makes it as their own edit, under their own grants.

## What the owner asked for

> so claude code via web ui can push and pull things?

And, asked what happens when an AI pushes several things at once (27 October): "Does it get
grouped? Prevented?" This record answers that in decisions 4 and 6.

## Decided

1. **Two ticks, both needed, both off by default.**
   - **The organisation:** Organisation › AI gets "AI apps may change designs", which only a
     Steward sets. Off, every connection in the organisation can only read and send ideas, whatever
     it was given.
   - **The person:** Allow and Make key get "May change designs". It shows only when the
     organisation's tick is on, starts unticked, and can be narrowed later by the owner or a
     Steward like any other grant (ADR-0072 decision 5). Turning the organisation's tick off stops
     every connection's changes at its next request; turning it back on does not tick anyone's
     connection again.
2. **Never beyond the person's own Draw.** A change is refused on any design whose folder the
   connection's owner cannot draw in at that moment, checked in the same transaction that writes
   it, as a browser's change is (ADR-0063 §1). Folders a Steward marked for a second person
   (ADR-0072 decision 8) refuse AI changes outright; the AI is told to send an idea instead.
3. **One new tool, `change_design`, in the same vocabulary as a live change.** It takes a design,
   the version the AI read, a one-line summary and a list of operations: add node, add edge, set
   field, tombstone. The server builds a `fathom-change 1` batch from it and applies it through the
   ADR-0063 path, so it is refused for everything a browser's change is refused for (undeclared
   fields, bad values, wrong endpoints, cycles, reused ids, a credential in stored text) and
   streams to every open browser like anyone's change. Nothing new is written to storage that a
   browser could not write.
4. **What it may touch is the reading's allowlist, one tier at a time.** A connection may set only
   the fields it may read (ADR-0072 decisions 2 and 21, at its own tiers), and add or remove only
   the kinds the `layout` tier lists. Never: security, NAT, IKE and IPsec kinds, serial numbers,
   street addresses and coordinates, contacts, file contents, history, a plan step's stored edit,
   who wrote a plan, and the vault. Two kinds of change are refused because they are hard to see
   undone: removing more than 20 things in one change, and removing a site, premises or rack that
   still holds anything.
5. **Grouped: one call is one change, one undo.** The batch carries the connection's owner as its
   author, as a browser's change does, and a mark that an AI made it through that connection
   (`via: ai:<key id>`). History shows "Claude, via Ann Alder: <summary>". One Undo reverts the
   whole change; History can restore the version before it. Undo of an AI change by anyone with
   Draw is allowed, unlike a person's change, which only its author undoes (ADR-0063 §6). **Amended
   when built (step 2):** the mark is not a field on the batch. The server keeps it in
   `ai_design_changes` (migration 0051), written in the transaction that stores the change, which
   History joins to show the connection's label. A browser can neither claim the mark nor strip it,
   and the design's schema gains nothing. The label is "AI: <summary>", cut to the 60 bytes a batch
   label holds. **Not built:** the one-click Undo by someone other than the owner. That needs the
   live head to know which batches an AI made, and the head has no database; until then anyone
   with Draw undoes an AI change through History's Restore, and its owner with Undo.
6. **It never overwrites a person's work.** `change_design` names the version it read. If the
   design has moved since, the change is refused and the AI is told to read again. There is no
   field-by-field merge for an AI, unlike a person's live change (ADR-0063 §5).
7. **Limits.** One change carries at most 200 operations. A connection makes at most 10 changes a
   minute and 300 a day, on top of ADR-0072's 60 requests a minute. Past either, it is refused
   with the time it may try again. A Steward can turn the organisation's tick off at once.
8. **Who is told.** Every AI change is a chain entry like any change, naming the connection.
   Organisation › AI shows each connection's last change and a count for the day. The owner of
   the connection and the Stewards see a notice when a connection is refused for its limits.
9. **Text from the AI goes through the server's gate.** The browser's redaction gate (rule 4)
   never sees an AI's text, because it never passes through a browser. The server's refusal
   (`looks_like_credential_bare`, the same check the AI ideas use) runs on every string value in
   the change, not only on `Capture.text` and `Note.text`. A refused change says which operation,
   never the value.
10. **The tool says what it is.** `whoami` says whether the connection may change designs.
    `change_design` exists in the tool list only for a connection that may. The helper gains the
    same tool, signed like its other requests.

## Built in this order

1. The two ticks, the policy and grant columns, and the screens (no changes possible yet).
2. `change_design` for set field only, on `layout` and `notes` fields, with decisions 5 to 9.
3. Add node, add edge and tombstone, with decision 4's limits.
4. The security sweep, then merge only when the owner says so.

## The sweep (27 October 2026)

Read against decisions 1 to 10 after steps 1 to 3 were built. Two faults found and fixed, each with a
test: a change refused because its owner may not draw there answered 500 instead of 403
(`an_ai_change_needs_its_owner_to_be_able_to_draw_there`), and a failure after the head had taken
the change but before the AI mark was written left the head holding it until its own timeout; it is
now released at once. Checked and left as they are: the ticks are read in the transaction that writes;
the version rule is checked after the design is locked; a removal is counted with its cascade and
refused if the cascade reaches a kind the reading hides; names given by an add cannot be mistaken for
ids; the mark cannot be written from a browser; every string value and the summary pass the server's
credential check; the request body is capped at 64 KiB. **Accepted, and said here:** a person with
ten connections has ten times the limits; text inside a design can still steer an AI that may change
it (the first negative consequence below).

## What this rules out

An AI that saves without both ticks; an AI change in a second-person folder; an AI change that
merges over a person's; a change outside the reading's allowlist; a change that skips the server's
gate because it did not come from a browser.

## Negative consequences

- **Prompt injection now changes data, not only ideas.** Text in a design can steer an AI that may
  change it. Before, the person's Accept was the defence (ADR-0072). Now it is the two ticks, the
  allowlist, the limits, one-click undo, and the record of who did what. That is weaker, and the
  ticks say so in plain words when they are set.
- **A person's Draw is lent to a program.** Anything the AI does is in their name, marked as the
  AI's. A stolen connection can change designs until it is stopped.
- **More server code that writes designs.** Before, only browsers wrote changes. The new path
  reuses ADR-0063's write path, so the rules are the same ones, but its inputs come from a program
  rather than a person's gestures.
