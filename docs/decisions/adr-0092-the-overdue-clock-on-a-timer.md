# ADR-0092: The overdue clock also runs on a timer

**Status:** accepted 2026-11-14. The owner answered sign-off card `r142-orders-finished` version 2
with "Wouldn't it be best to be a combination of both? And if so I want this done before alpha".
This record is the decision record that card said a timer would need. It relaxes one rule of
`docs/PHASE-2-STORAGE-DESIGN.md` §4 for one caller, and says exactly how far.

## Why

ADR-0084 decision 11 gives a job `overdue` rules: escalate, reassign, or move an optional job on,
once its time has come. Version 1 of the clock (migration 0080) carries them out when anyone opens
or acts on an order, stamped with the time each rule fell due. That is never wrong and never out of
order, but a rule can be late: if nobody looks at orders over a weekend, Saturday's escalation
happens on Monday. The owner wants both: the read path as it is, and a timer on the server so a
rule happens on time when nobody is signed in.

The obstacle is §4: *"The tenant key is pinned from the authenticated request context for the
request's lifetime, and never taken from the row being read. This is what actually preserves
cross-tenant separation."* An order is sealed under its organisation's key. A timer has no request,
so it has no pinned tenant, and before this record the only way to know which orders are due was to
open them all.

## Decisions

1. **Each order keeps one plain time beside its sealed history: when its next overdue rule falls
   due** (`orders.next_overdue_at`, migration 0081; `Order::next_overdue` in the engine). NULL when
   no rule is waiting or the order is closed. It is written in the same statement that stores the
   order's status after every event (open, an act, a rule carried out, a plan recorded), so it never
   lags the history. It says when, and nothing about what: the same kind of fact as `opened_at`,
   `updated_at` and each event's `at`, which are already in the clear. An order stored before 0081
   gets it the first time it is read.

2. **The timer finds due orders through a door of its own, which reads one table and writes
   nothing.** `app.order_clock_custody`, set by `orders::enter_clock_custody` alone, has one policy:
   `FOR SELECT` on `orders`. The rows it can read hold ids, numbers, statuses and times, never
   sealed content. It has no policy on `order_events`, `order_types`, any key table or any design
   table, and no `UPDATE` or `INSERT` policy anywhere. It sets `app.design_capability` to its
   refusal. This is the same shape as migration 0059's firmware re-check door.

3. **A due order is opened under its own organisation, as the system account, in a transaction of
   its own.** `repo::open_clock_context` is the second constructor of `TenantContext` and the only
   one not built from a membership row. It sets `app.design_capability` to its refusal first and
   never to anything else, and sets `app.account_id` empty, which every policy treats as a refusal.
   The actor is the system account (migration 0074, whose own header already names ADR-0084's
   escalations as one of its future users), with the role Member, so it can never save an order
   type. Every row it reads or writes is still matched by the ordinary tenant predicate.

4. **Why this crossing of §4 is acceptable, and what it does not allow.** §4's pinning stops a
   person's request for one organisation from opening another's data and showing it to them. The
   timer has no person to show anything to. It takes the organisation from an `orders` row (0075's
   trigger stops that column ever changing), reads that organisation's order under that
   organisation's key, and writes the result back into the same organisation's history. Nothing it
   opens leaves the server or reaches anyone but the members who could already read the order.
   Each order event's AAD also names its organisation, so an event row moved under another
   organisation fails to open (`Refused`), as before. What it does not allow: the clock context
   reaches no design payload, no vault, no team or grant act, and no route can build one.
   `open_clock_context` is `pub(crate)` with one caller, `orders::clock_one`.

5. **Both paths carry out the same rules, once, in order.** The timer (`orders::spawn_clock`,
   started from `main.rs`) looks every minute, because rules are written in minutes, and opens at
   most 200 orders a pass; the rest wait a minute. For each it locks the order's row, checks it is
   still open and still due, and runs the same `catch_up_overdue` the read path runs. The row lock
   makes the timer and a person's read take turns, and on a cluster (ADR-0090) two servers' timers
   do too: whichever comes second replays the history and finds nothing left to do. Each rule is
   still stamped with the time it fell due. The timer runs only the overdue rules; a recorded plan
   still finishes its job when the order is next read, as before.

6. **A failure is logged and retried; it never stops the server.** An order the timer cannot open
   or store is logged with its organisation and id and tried again next minute, and anyone opening
   the order still carries the rule out by the read path.

## Consequences

- A rule now fires within about a minute of falling due while the server is up. If the server is
  down, the first pass after it starts catches up, as the read path always did.
- One new plain column on `orders` and one new read-only custody setting. `docs/OPERATING.md`'s
  section on the system account says what the clock does as it, and what it logs when it can't.
- The tests: `the_clock_carries_out_a_due_rule_on_its_timer_with_nobody_signed_in` in
  `crates/fathom-server/tests/orders.rs` opens an order whose rules are due at once, runs a pass
  with nobody reading, and checks both rules were stored as the engine's, the next-due time
  cleared, a second pass and a later read fire nothing more, another organisation's pass leaves the
  order alone, and the clock's door reads `orders` only and cannot write.
