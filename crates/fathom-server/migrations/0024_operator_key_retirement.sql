-- ---------------------------------------------------------------------------
-- 0024 -- RETIRING AN OPERATOR KEY, SO THAT BREAK-GLASS DISPOSSESSES SOMEBODY
--
-- ADR-0055 decision 8, and the checker finding of 2026-09-21 against the
-- merged build: `fathom-server recover-operator <address>` restored ACCESS and
-- dispossessed NOBODY. Redeeming its code changed exactly one thing,
-- `accounts.password_hash`. The lost browser kept its operator session, kept
-- its operator key, and the old app code and backup codes still worked -- so
-- the quiet mailed path (decision 7, which ends every session) was strictly
-- stronger than the loud host path, and on the sole-operator deployment
-- decision 4 calls standing, a stolen browser was permanent: such an operator
-- can neither disable themselves (`operators.rs`) nor be disabled (`0019` §C's
-- last-live floor).
--
-- `0015` §B wrote the column and said so in its own comment:
--
--     `retired_at` is here and nothing writes it yet: it is inside the row
--     seal, so adding it later would mean re-sealing every row.
--
-- and `0015` §I then took the privilege away:
--
--     A keyring row is written once. Nothing supersedes or retires an operator
--     key yet, so nothing updates one; taking the privilege back when that
--     lands is a migration somebody has to write down (`0013` §F's rule).
--
-- This is that migration. No re-sealing of existing rows is needed:
-- `operator_key_row_state` has carried `retired_at` since the table was
-- written, with the value 0 for a live key, which is what every stored seal
-- already covers.
--
-- # What it does NOT grant
--
-- Three columns and no more. `public_key`, `fpr`, `operator_id`,
-- `enrolled_seq` and `key_source` stay un-updatable: a keyring row whose
-- public key could be changed is a keyring row an administrator could sign in
-- through as somebody else, which is the thing `live_operator_keys`' alarm
-- exists for. There is still no DELETE -- a deleted key is an enrolment nobody
-- can account for -- and there is still no supersession (`superseded_by`,
-- `succession_sig`), because no path signs one.
--
-- # The policy, and why it is the operator custody
--
-- `operator_keys_readable` already admits `app.operator_custody` or
-- `app.session_custody`; `operator_keys_insertable` names
-- `app.enrolment_custody`, because until ADR-0055 every operator key arrived
-- by redemption. The one writer of `retired_at` is
-- `operators::recover_operator`, which runs on the host inside the operator
-- custody, so the UPDATE policy names that custody and not the enrolment one:
-- an unauthenticated redemption must not be able to retire anybody's key.
--
-- Every policy names its command and none is `FOR ALL` -- `0003`'s bug,
-- restated on every migration that writes one.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS operator_keys_retirable ON operator_keys;
CREATE POLICY operator_keys_retirable ON operator_keys
    FOR UPDATE USING (current_setting('app.operator_custody', true) = 'yes')
            WITH CHECK (current_setting('app.operator_custody', true) = 'yes');

GRANT UPDATE (retired_at, row_version, row_seal) ON operator_keys TO fathom_app;
