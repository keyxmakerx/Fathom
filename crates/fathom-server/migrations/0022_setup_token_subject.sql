-- 0022 -- the `setup` purpose's subject column, which `0019` meant to open and
-- did not.
--
-- ADR-0055 decision 10's last bullet, and stream (a) of the build contracts at
-- `docs/archive/2026-09-21-adr-0055-build-contracts.md`.
--
-- ---------------------------------------------------------------------------
-- WHAT WENT WRONG, EXACTLY, AND HOW IT WAS FOUND
-- ---------------------------------------------------------------------------
--
-- `0015_operator_console.sql` created `enrolment_tokens` with three ANONYMOUS
-- table-level `CHECK`s, one per purpose. PostgreSQL named them itself:
-- `enrolment_tokens_check`, `_check1`, `_check2`. The middle one is
--
--     CHECK ((purpose = 'operator') = (operator_id IS NOT NULL))
--
-- `0019_operator_account_binding.sql` §B adds the fourth purpose, `setup`, and
-- widens that rule to
--
--     CHECK ((purpose IN ('operator','setup')) = (operator_id IS NOT NULL))
--
-- under the name `enrolment_tokens_operator_id_check`. **But it drops
-- `enrolment_tokens_operator_id_check` first, and that name never existed** --
-- `0015`'s constraint is called `enrolment_tokens_check1`. So `0019` added a
-- second, wider rule beside the original narrow one instead of replacing it,
-- and PostgreSQL enforces every `CHECK` on a table. A `purpose = 'setup'` row
-- with `operator_id` set satisfies the new rule and violates the old one:
--
--     new row for relation "enrolment_tokens" violates check constraint
--     "enrolment_tokens_check1"
--
-- **So no setup token could ever be written, and decision 10's first-operator
-- setup could not exist.** Found by `tests/credentials.rs`'s
-- `a_setup_token_sets_a_password_once_and_hands_back_no_session` on
-- 2026-09-21, against a real database, which is the only place it could have
-- been found: `0019` applies cleanly and the gap only shows on an INSERT.
--
-- ---------------------------------------------------------------------------
-- WHY A NEW FILE AND NOT AN EDIT TO 0019
-- ---------------------------------------------------------------------------
--
-- `src/migrate.rs` holds a checksum of every migration's bytes and
-- `tests/migrate_gate.rs` refuses an edited one. `0019` is registered and has
-- been applied to every database in this project's worktrees; editing it turns
-- every one of them into "a migration was edited", which is a forgery alarm,
-- for a fix that is one statement. The same argument `0018`'s header makes
-- about `0013`, `0014`, `0015` and `0017`.
--
-- **Idempotent and safe on a database that never saw the bad state**:
-- `DROP CONSTRAINT IF EXISTS`, and the wider rule `0019` added stays and is
-- the one that binds. Nothing is loosened -- `enrolment_tokens_operator_id_check`
-- still requires `operator_id` for exactly `operator` and `setup` and still
-- forbids it for `account` and `organisation`.
--
-- ---------------------------------------------------------------------------
-- MERGE NOTE FOR THE OTHER TWO ADR-0055 STREAMS
-- ---------------------------------------------------------------------------
--
-- Stream (b) is writing its own migration too (the lead's resolution 10: the
-- `0015` CHECK that forbids seconding a `single_operator = true` row is
-- relaxed). If both land as 22, renumber one of them and re-run
-- `tests/migrate_gate.rs`; the two files touch different tables and different
-- constraints, so the order between them does not matter.

ALTER TABLE enrolment_tokens DROP CONSTRAINT IF EXISTS enrolment_tokens_check1;

-- Stated again by name, so that a database restored from before `0019` and
-- rolled forward ends in the same place as one that was never broken. `ADD
-- CONSTRAINT` re-validates every existing row, and `enrolment_tokens` is
-- behind `FORCE ROW LEVEL SECURITY` -- so the invariant-11 `NO FORCE`/`FORCE`
-- pair every migration since `0010` uses is taken here for the reason those
-- files give: the re-validation is a read, and with no capability set it
-- returns zero rows SILENTLY and validates nothing.
ALTER TABLE enrolment_tokens NO FORCE ROW LEVEL SECURITY;

ALTER TABLE enrolment_tokens DROP CONSTRAINT IF EXISTS enrolment_tokens_operator_id_check;
ALTER TABLE enrolment_tokens
    ADD CONSTRAINT enrolment_tokens_operator_id_check
    CHECK ((purpose IN ('operator', 'setup')) = (operator_id IS NOT NULL));

ALTER TABLE enrolment_tokens FORCE ROW LEVEL SECURITY;
