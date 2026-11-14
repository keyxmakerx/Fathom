-- 0081 -- the overdue clock also runs on a timer, with nobody signed in (ADR-0092; the owner asked
-- for "a combination of both" before the alpha on 14 November 2026).
--
-- An order is sealed under its organisation's key, and a server task with no request cannot read
-- which sealed orders have a rule due without opening them all. So each order keeps, in the clear,
-- one thing beside its sealed history: the time its next overdue rule falls due, or NULL when none
-- is waiting. It is a time and nothing else, of the same kind as `opened_at`, `updated_at` and each
-- event's `at`, which are already in the clear. The server writes it every time it stores the
-- order's standing (open, an act, a rule carried out). An order stored before this migration has
-- NULL until someone next opens or acts on it, which is when the clock ran before.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS next_overdue_at bigint NULL;

CREATE INDEX IF NOT EXISTS orders_next_overdue_idx
    ON orders (next_overdue_at)
    WHERE status = 'open' AND next_overdue_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- THE CLOCK'S DOOR. The timer runs with no session and no tenant, so it needs to find which orders
-- are due across every organisation. It gets a capability of its own, `app.order_clock_custody`,
-- set by exactly one function in the server (`orders::enter_clock_custody`), and that capability
-- READS `orders` only: no UPDATE or INSERT policy names it, and no other table does. The rows it
-- reads hold no sealed content. Every write the clock makes is under the order's own organisation,
-- through the ordinary tenant predicate, as the system account (0074), with
-- `app.design_capability` at its refusal, so it reaches no design. The same door as 0059's
-- firmware re-check.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS orders_readable_for_clock ON orders;
CREATE POLICY orders_readable_for_clock ON orders
    FOR SELECT USING (current_setting('app.order_clock_custody', true) = 'yes');
