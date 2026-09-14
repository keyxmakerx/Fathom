-- 0014 -- session hardening: the corrections an adversarial round found in
-- 0013's sign-in and session layer, and the three columns and one table they
-- need.
--
-- `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §4 and §13 item 7;
-- `docs/PHASE-2-STORAGE-DESIGN.md` §12.2 (the label table, which wins over
-- code); `.context/conventions.md` invariant 11.
--
-- **0013 is not edited and must never be.** It has shipped and is under the
-- checksum gate in `src/migrate.rs`, so every correction to what it SAYS is
-- written here instead, in section 0, and every correction to what it DOES is
-- a statement further down this file.
--
-- ---------------------------------------------------------------------------
-- 0. WHAT 0013's HEADER GETS WRONG, CORRECTED HERE BECAUSE IT CANNOT BE
--    CORRECTED THERE
-- ---------------------------------------------------------------------------
--
-- **0013 §D calls the account bucket a lockout. It is not one, it never was
-- one in the code, and the decision taken 2026-09-14 is that it stays a rate
-- limit.** 0013 §D's second bullet reads *"two buckets, both counted, either
-- one refusing"*, and `src/sessions.rs`'s `SignInLimits::defaults` said *"the
-- account number is a lockout and the source number is a rate limit"*. Neither
-- was true of the build: `sign_in` checks the SOURCE bucket before it attempts
-- anything, and the account bucket is read only on a path that has ALREADY
-- failed — so a caller whose signature is good is never refused by the account
-- bucket, however many failures that account has collected.
--
-- The decision is to make the code say what it does rather than make it do
-- what the comment said:
--
--   * **On an unauthenticated surface a lockout is a denial of service against
--     a named person.** Anyone who knows an address can fail eleven signatures
--     and take that person off the air for the rest of the window. The attack
--     costs nothing and needs no secret.
--   * **There is no password here to brute force.** Sign-in is a signature by
--     a key enrolled in `account_keys` (§15.1); the only way past it is the
--     private half. A lockout on failures buys almost nothing against an
--     attacker who cannot produce a signature anyway, and the rate limit
--     already bounds how fast they may try.
--
-- So: both buckets are RATE LIMITS. The account bucket bounds how much work
-- and how much sealed audit one claimed identity can cause inside a window;
-- the source bucket bounds one address. `src/sessions.rs` is corrected to say
-- exactly that, and §13 item 7 of the admin design — which lists *"rate
-- limiting, lockout, and the sign-in surface itself"* as unspecified — needs
-- its own correction from the lead: **there is no lockout and there is not
-- going to be one**.
--
-- ---------------------------------------------------------------------------
-- A. THE CLAIMED-ADDRESS KEY — CLOSING THE ACCOUNT ORACLE
--
-- **The defect.** 0013 counted the account bucket only when the consumed bind
-- nonce carried a principal. An address belonging to nobody therefore never
-- crossed the account cap and always answered the ordinary refusal, while a
-- real address answered `429` with a `Retry-After` header from the eleventh
-- attempt. That is a clean oracle over the deployment's user list, reachable
-- by anyone, and `src/sessions.rs`'s own `SessionError` documentation claimed
-- it was closed.
--
-- **The fix, and why it is a column.** The account bucket must be counted for
-- an address that resolves to nothing as well. The address itself must NOT be
-- the bucket key: `sign_in_attempts` would then hold a list of addresses that
-- are not accounts — typed by whoever typed them, which on a sign-in page
-- includes people's real addresses at other services and the occasional
-- password typed into the wrong box. So the key is
--
--     claimed_address_key = MAC(K_addr, LP("fathom/session/address/v1")
--                                       || LP(address))
--     K_addr              = HKDF-Expand(site chain key,
--                                       "fathom/session/kdf/address/v1", 32)
--
-- derived from the site chain key exactly as `authority::row_key` derives its
-- own subkey, under two new labels for `PHASE-2-STORAGE-DESIGN.md` §12.2's
-- table. `K_addr` is not in PostgreSQL, so the column is not a list of
-- addresses to anyone holding the database; it is a stable per-address
-- grouping and nothing else.
--
-- The address is known at `/session/challenge` and NOT at `/session` — §4.2
-- deliberately keeps the address out of the sign-in message, so the account is
-- whoever the consumed nonce names. The key therefore has to travel on the
-- nonce row, which is what this column is.
--
-- **It is written for every bind nonce, not only for the ones that resolve to
-- nothing.** A column that is NULL exactly when the address exists is the same
-- oracle one layer down, readable by anything that can read the table.
-- ---------------------------------------------------------------------------

-- A bind nonce lives two minutes (`sessions::NONCE_LIFETIME`), so clearing the
-- outstanding ones costs one in-flight sign-in per client and nothing else.
-- It is done because the CHECK below validates every row already in the table
-- and rows written under 0013 carry no key.
--
-- **The `NO FORCE` / `FORCE` pair is load-bearing**, for the reason 0013 §G
-- states about its own: this table is behind `FORCE ROW LEVEL SECURITY` and
-- the migration role owns it, so both the DELETE and the constraint's
-- validating scan would reach ZERO rows silently without it. On an empty
-- database the difference is invisible.
ALTER TABLE session_nonces NO FORCE ROW LEVEL SECURITY;

DELETE FROM session_nonces WHERE purpose = 'bind';

ALTER TABLE session_nonces
    ADD COLUMN IF NOT EXISTS claimed_address_key bytea;

ALTER TABLE session_nonces
    DROP CONSTRAINT IF EXISTS session_nonces_bind_carries_a_claimed_address_key;

ALTER TABLE session_nonces
    ADD CONSTRAINT session_nonces_bind_carries_a_claimed_address_key
    CHECK (
        (purpose = 'bind') = (claimed_address_key IS NOT NULL)
        AND (claimed_address_key IS NULL OR octet_length(claimed_address_key) = 32)
    );

ALTER TABLE session_nonces FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- B. THE ANONYMOUS LATCH — ONE SEALED ENTRY PER (SOURCE, WINDOW)
--
-- **The defect.** 0013 §D's latch was `locked_entry_written`, taken only when
-- a bucket had already closed. For an ANONYMOUS failure no account bucket was
-- counted, so nothing was ever locked and `src/sessions.rs` appended an
-- `account_signin_failed` entry on every single attempt. An unauthenticated
-- caller therefore chose how fast this deployment's sealed audit chain grew,
-- which is the amplifier 0013 §D says the latch exists to prevent. The test
-- that claimed to close it used a KNOWN address with a small account cap —
-- the one case where the old latch does fire — so the attacker in that test
-- was never anonymous.
--
-- Section A's fix does not close this on its own: with a claimed-address
-- bucket the attacker simply varies the address and gets a fresh bucket, a
-- fresh cap and a fresh run of entries each time.
--
-- **The fix.** A second latch, on the SOURCE row, taken on the first anonymous
-- failure of a window. A (source, window) pair yields at most one anonymous
-- entry however many addresses are sprayed through it.
--
-- **Two latch columns and not one**, because they record two different facts
-- and sharing one would silently swallow the other: `locked_entry_written`
-- still marks "this bucket crossed its cap and that was recorded once", and is
-- what the source-cap refusal takes; `anon_entry_written` marks "a refusal
-- from this source with no account behind it was recorded once". A named
-- account's failures stay bounded by its own bucket — at most one entry per
-- attempt up to the cap, then one more — which is a signal an operator wants
-- and an attacker cannot inflate without holding the address.
-- ---------------------------------------------------------------------------
ALTER TABLE sign_in_attempts
    ADD COLUMN IF NOT EXISTS anon_entry_written boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- C. THE SWEEP, AND THE ONE PRIVILEGE IT NEEDS
--
-- **The defect.** Nothing in 0013 ever deleted an expired row. The only two
-- DELETEs in `src/sessions.rs` matched one exact nonce, `issue_challenge`
-- counted no attempt at all, and 0013 §F took DELETE on `sign_in_attempts`
-- away from `fathom_app` on the argument that *"nothing deletes one, and the
-- window makes old rows harmless"*. Harmless to correctness; not harmless to a
-- disk. One anonymous POST to `/session/challenge` was one permanent
-- `session_nonces` row, and `sign_in_attempts` grew one row per (source,
-- window) for ever.
--
-- **The fix is a sweep on the write path of each of the three tables**, not a
-- background task: this deployment is two interchangeable containers with no
-- scheduler, and a sweeper that runs in only one of them is a sweeper that
-- stops when that one is rescheduled. Each sweep is bounded
-- (`sessions::SWEEP_BATCH`) and drives the index the table already has —
-- `session_nonces_expiry_idx`, `sessions_expiry_idx`,
-- `sign_in_attempts_window_idx` — so the cost is a small constant per write
-- and the steady state is bounded by the arrival rate rather than by time.
--
-- 0013 §F predicted this line: *"a future sweeper would need this back, and
-- taking the privilege back is a migration somebody has to write down."* This
-- is that migration. **DELETE and nothing more**: UPDATE stays revoked down to
-- the two counter columns plus section B's latch, and no other verb is added
-- on any of the three tables.
-- ---------------------------------------------------------------------------
GRANT DELETE ON sign_in_attempts TO fathom_app;
GRANT UPDATE (anon_entry_written) ON sign_in_attempts TO fathom_app;

-- A DELETE privilege with no DELETE policy reaches zero rows silently, which
-- is invariant 11's failure mode and exactly what a sweep must not do. Named
-- command, never `FOR ALL` — 0003's bug, restated.
DROP POLICY IF EXISTS sign_in_attempts_deletable ON sign_in_attempts;
CREATE POLICY sign_in_attempts_deletable ON sign_in_attempts
    FOR DELETE USING (current_setting('app.session_custody', true) = 'yes');

-- ---------------------------------------------------------------------------
-- D. SIGN-OUT IS RECORDED, NOT ONLY PERFORMED
--
-- **The defect.** 0013 made sign-out a DELETE and argued for it: *"a deleted
-- row cannot be resurrected without the site row key, which is not in
-- PostgreSQL."* That is true of MINTING a row and false of RESTORING one. The
-- session row's MAC covers only the row's own fields — id, principal, public
-- key, evidence, times — and none of those change when it is signed out, so
-- last night's backup holds a set of bytes that verify for ever. A tier-3
-- attacker who re-inserts one row silently undoes a sign-out, and nothing in
-- the schema recorded that the id had ever existed.
--
-- **The fix, in the shape the authority tables already use for revocation.**
-- An append-only row, sealed under the same site-scoped row key with
-- `authority::row_seal` and bound to a sealed site-chain entry by `chain_seq`
-- — `grant_revocations`' shape exactly, and no new label (0013's departure 2
-- carries that argument: a label separates USES of one key, and this is not a
-- new use). Verification refuses any session id that appears here, so the
-- restored row fails at its first request.
--
-- **What it does and does not buy.** A selective restore of the `sessions`
-- row — the cheap move, and the one the finding names — is closed: the
-- revocation row is still there and still sealed, and `fathom_app` cannot
-- delete it at all. A restore of the WHOLE database to a point before the
-- sign-out is not closed by anything inside the database, and §7.6 already
-- says so; what catches that is the off-box anchor, not this table.
--
-- **No foreign key to `sessions`.** The row it is about is gone by design;
-- a REFERENCES would make recording the fact impossible at the moment it
-- becomes true.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS session_revocations (
    session_id   text        PRIMARY KEY CHECK (char_length(session_id) = 26),

    -- Kept so an operator reading the sealed trail can see whose session ended
    -- without joining to a row that no longer exists.
    principal_id text        NOT NULL,

    -- One value today. It is a `CHECK` and not free text so that a second
    -- reason has to be written down somewhere a reader can find it.
    reason       text        NOT NULL CHECK (reason IN ('signed_out')),

    revoked_at   timestamptz NOT NULL DEFAULT now(),

    -- The `account_signed_out` entry on the site chain, inside the MAC. §0's
    -- "stopping the log stops the act", for sign-out as for sign-in.
    chain_seq    bigint      NOT NULL CHECK (chain_seq >= 1),

    row_version  integer     NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    row_mac      bytea       NOT NULL CHECK (octet_length(row_mac) = 32)
);

CREATE INDEX IF NOT EXISTS session_revocations_principal_idx
    ON session_revocations (principal_id);

ALTER TABLE session_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_revocations FORCE  ROW LEVEL SECURITY;

-- Read and insert, under the same transaction-local capability as the other
-- three session tables (0013 §E). **There is deliberately no UPDATE policy and
-- no DELETE policy**: append-only is stated twice, once here and once in the
-- privilege grants below, because a policy layer and a privilege layer failing
-- together is less likely than either failing alone.
CREATE POLICY session_revocations_readable ON session_revocations
    FOR SELECT USING (current_setting('app.session_custody', true) = 'yes');
CREATE POLICY session_revocations_insertable ON session_revocations
    FOR INSERT WITH CHECK (current_setting('app.session_custody', true) = 'yes');

REVOKE UPDATE, DELETE ON session_revocations FROM fathom_app;

-- ---------------------------------------------------------------------------
-- E. ONE NEW SITE ENTRY TYPE
--
-- `account_signed_out`. §7.2 names no type for it, in the same gap 0013 §G
-- reported for `account_signin` and `account_signin_failed`: §7.2 was written
-- for the operator surface and §4 made the account session the main path. The
-- omission is the document's and is reported rather than worked around.
--
-- Extended by `DROP CONSTRAINT` then `ADD CONSTRAINT`, wrapped in the
-- invariant-11 `NO FORCE` / `FORCE` pair — the path 0010 §C documents, 0011 §K
-- and 0013 §G follow, and which is LOAD-BEARING for exactly the reason those
-- files give: `ADD CONSTRAINT ... CHECK` re-validates every row already in
-- `chain_entries`, and that scan is a read of a table behind `FORCE ROW LEVEL
-- SECURITY`, which with no tenant context returns zero rows SILENTLY.
--
-- Mirrored by `EntryType::kinds()` in `src/chain.rs`.
-- ---------------------------------------------------------------------------
ALTER TABLE chain_entries NO FORCE ROW LEVEL SECURITY;

ALTER TABLE chain_entries
    DROP CONSTRAINT IF EXISTS chain_entries_type_belongs_to_kind;

ALTER TABLE chain_entries
    ADD CONSTRAINT chain_entries_type_belongs_to_kind
    CHECK (
        (chain_kind = 'design'
             AND entry_type IN ('create', 'update', 'reencrypt'))
     OR (chain_kind = 'site'
             AND entry_type IN ('deployment_started', 'shipper_gap',
                                'spool_pressure', 'rewrap',
                                'account_signin', 'account_signin_failed',
                                'account_signed_out',
                                'operator_signin_failed',
                                'account_disabled', 'account_enabled'))
     OR (chain_kind = 'org'
             AND entry_type IN ('org_genesis', 'rewrap',
                                'account_key_enrolled', 'account_key_superseded',
                                'account_key_retired',
                                'grant_signed', 'grant_seconded',
                                'grant_suspended', 'grant_unsuspended',
                                'grant_revoked', 'auth_head_advanced'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
