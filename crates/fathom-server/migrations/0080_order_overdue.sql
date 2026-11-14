-- 0080 -- the overdue clock's own action on an order (ADR-0084 decision 11, piece 3; the owner
-- asked for it before the alpha on 14 November 2026).
--
-- An order type may give a job `overdue` rules; once a rule's time has come the engine carries it
-- out (escalate, reassign or move on) and records it in the order's history as its own act, with
-- no account (`by_account` NULL, as 0075 already allows for a recorded plan). This adds that one
-- action word. Numbered 0080 because 0079 is taken by the mail outbox on another branch.

ALTER TABLE order_events DROP CONSTRAINT IF EXISTS order_events_action_check;
ALTER TABLE order_events ADD CONSTRAINT order_events_action_check CHECK (action IN (
    'open', 'answer', 'pick_up', 'tick', 'link_plan', 'finish',
    'send_back', 'cancel', 'approve', 'cancel_order', 'overdue'));
