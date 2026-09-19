# ADR-0054 — A save carries its base; a drawer creates a design; a steward creates a scope

**Status:** accepted 2026-09-19 on the owner's "continue" over the Session 7 plan.
**Binds with:** admin design §3.1 (read opens, draw edits, steward grants), §6.4 (a scope is created
by a steward of the parent), ADR-0049 (the payload is the plain face), ADR-0046 §6 (never a silent
overwrite).

## Context

Two browsers saving the same design in turn overwrote each other silently: the save had no
precondition. No route created a design, and none created a scope, so a person could not reach a
design from a fresh deployment, and no driven sign-in flow could either.

## Decision

1. **A save names the version it was based on**, in the signed query, required: an optional
   precondition is no precondition. The server serialises on the design's row lock, refuses a base
   that is not the current version with a conflict answer naming both numbers in one sentence,
   writes nothing and appends nothing, and otherwise writes base plus one. The client keeps its
   base on a refusal and never adopts the server's current version, because that is the silent
   overwrite by another name; the refusal wash names the change and offers reload; reload and
   reapply belongs to live editing.
2. **Draw creates a design.** Admin §3.1 gives draw the right to edit and reserves steward for
   grants and scopes; the first version's create entry was already written by a drawer. The route
   takes the scope in the signed path and the client's empty document as the body through the
   same validation a save uses, creates the design and its first version in one transaction so a
   bodiless design is never minted, and answers with the same shape the list gives.
3. **A steward of the parent creates a scope**, per §6.4, by a route that takes the parent and a
   label; Home offers it to a steward and offers a new design in any scope the person may draw
   in. A design still has no name, by D11.

## Consequences

An older client that sends no base is refused; deliberate. An organisation chain entry for a
created design needs a migration and is deferred. The driven sign-in flow can now reach a design
from nothing, which Session 7's proof uses.
