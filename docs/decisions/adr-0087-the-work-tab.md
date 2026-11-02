# ADR-0087: The Work tab — one list of work across designs, with Fathom numbers

**Status:** accepted 2026-11-02. The owner answered sign-off card r74-plans-view: where "A work tab
over what exists", ticket "A assign status due", live "A live rows and who". Then, on r75, the plan
for building it: "looks great, signed off".

**Builds on:** ADR-0079 (the estate index), ADR-0076 (spares and stores), the troubleshooting issues
and maintenance plans already in the schema.

## Decided

1. **A Work tab over what exists, not a new kind.** Maintenance plans, troubleshooting issues, and
   spares on order, in repair or lent are the work. Each keeps its own status words. The tab lists
   them from every design the caller may read, rechecked on every request, as estate search does.

2. **The list comes from the estate index.** Plan and issue rows join device and spare rows, sealed
   the same way. A row's work summary (open or done, state, when, who, ticket, step counts, comment
   count) is inside the sealed row; `work:open` and `work:done` are its only new search terms.

3. **Every work row gets a Fathom number, `W-<n>`.** The server gives it, per organisation, in order,
   when the row is first indexed, and never gives it again, even after the item is deleted
   (`work_numbers`: the app role may insert and read, never update or delete). It is not a schema
   field: a design copied to another organisation gets that organisation's own numbers.

4. **Assigned to, due and an outside ticket are schema fields (0.34).** `assigned_to` holds an
   account id, chosen from the people who hold Draw on the design. `ticket` is a link to Jira or any
   other tracker; the client opens only http and https links. `due` is on issues; plans already have
   a window and spares an expected date. All three pass the credential check like other text, and a
   pasted ticket passes the redaction gate first.

5. **Comments are notes.** The short thread on an item is its notes (`HasNote`), with who wrote each
   and when, so plans, issues and spares join the notable kinds.

6. **Live means fresh, not pushed, for now.** The tab asks again every five seconds while it is
   shown, and shows who is in each design now from the live presence the server already keeps. An
   organisation-wide stream is later work, if five seconds proves too slow.

## Later

Teams as assignees, orders with types, phone-first cards beyond the narrow layout, audits, calendar
export and notifications (the rest of r74's "also" list).
