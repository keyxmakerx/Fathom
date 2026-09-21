-- 0021: the hold on the operator seat after a password reset.
--
-- ADR-0055 decision 7: a mailed reset sets a new password and never, by
-- itself, restores the operator custody. The account may sign in, but it
-- may not register a key into `operator_keys` -- the thing every operator
-- act is signed with -- until either another operator confirms it or the
-- 24-hour delay has run with notice to every operator. That is what keeps
-- a colleague who controls the mail server from resetting their way into
-- a second seat.
--
-- One column, on `accounts`, because the hold is a fact about the person
-- whose password was reset, not about any one operator row: `NULL` means no
-- hold; a timestamp is when the hold ends. Written by the reset redemption
-- (stream (a) of the build contracts), cleared early by another operator's
-- confirmation or read as expired by the clock (stream (b)); read by the
-- operator key registration (stream (b)). Added in its own migration ahead
-- of both streams because each needs it and neither may write the other's
-- SQL.
--
-- Not sealed: the seal on an operator's authority is the row in
-- `operator_keys` the hold prevents being written; a database holder who
-- clears this column early still has to produce a sealed key row and the
-- chain entry beside it, which they cannot.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS operator_key_hold_until timestamptz;

-- The runtime role writes it where 0018 lets it write the other credential
-- columns, and nowhere else. Column-level, as every grant on `accounts` is.
GRANT UPDATE (operator_key_hold_until) ON accounts TO fathom_app;
