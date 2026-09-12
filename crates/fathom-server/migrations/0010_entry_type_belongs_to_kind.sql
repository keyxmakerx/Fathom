-- 0010 -- the entry-type constraint 0009 said it had built, and the one
-- enumeration a deployment-wide re-wrap needs.
--
-- `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §7.2;
-- `docs/PHASE-2-STORAGE-DESIGN.md` §12.6; `.context/conventions.md` invariant 11.
--
-- ---------------------------------------------------------------------------
-- A. WHAT WENT WRONG, IN ONE PARAGRAPH
-- ---------------------------------------------------------------------------
--
-- 0007 wrote `CHECK (entry_type IN ('create','update','reencrypt'))` inline and
-- unnamed. 0009 DROPPED it -- correctly, because three of the new types are not
-- design types -- and then **did not add the replacement**. Its own header says
-- otherwise in two places ("`chain_entries_type_belongs_to_kind` pairs each
-- entry type with the one chain kind it may be filed on") and so did
-- `EntryType::chain_kind`'s doc in `src/chain.rs`. No such constraint was ever
-- created. So between 0009 and this file `entry_type` was FREE TEXT: the
-- runtime role could insert `'creat'`, `'rewrap '` or anything else, on any
-- chain kind, through the ordinary INSERT policy and with no privilege it did
-- not already hold.
--
-- The damage is not the junk row. It is that `chains::read_entries` and
-- `designs::read_entries` turned an unparseable type into `Err`, so one such
-- INSERT made that chain permanently UNVERIFIABLE -- no outcome at all, rather
-- than §11.2's "broken at entry N with everything before it verified". A
-- tamper-evident log that can be silenced by a value in a text column is not
-- one. **Both halves are fixed and they are independent:** this constraint
-- stops the row arriving, and `chain::verify` now reports
-- `BreakReason::EntryTypeNotRecognised` at the row for any that ever does --
-- because a constraint binds statements, and whoever can `ALTER TABLE` can
-- drop it, which `0009`'s own header already rates a tier-3 move.
--
-- ---------------------------------------------------------------------------
-- B. THE PAIRING, AND THE ONE TYPE THAT IS FILED ON TWO KINDS
-- ---------------------------------------------------------------------------
--
--   design -- create, update, reencrypt                       (§11.2, 0007)
--   site   -- deployment_started, shipper_gap, spool_pressure,
--             rewrap                                          (§7.2, §9)
--   org    -- org_genesis, rewrap                              (§7.2)
--
-- **`rewrap` belongs on both, and that is the fix to a defect rather than a
-- loosening.** Storage §12.6 requires the record of the fact on a TENANT-level
-- chain, one entry per organisation whose keys moved. But a re-wrap is
-- deployment-wide, because the master key is: there is exactly one active
-- master key per database (0007's `master_keys_one_active_idx`), so switching
-- it changes custody for EVERY tenant at once. `keys::rewrap_master_key` writes
-- one summary entry on the site chain -- old master id, new master id, how many
-- tenants moved -- and one entry on each affected organisation's chain naming
-- that tenant's own epochs, in a single transaction. §7.2 anticipated exactly
-- this ("a site-level summary entry for the operator's act may be added later;
-- it is not the record of the fact").
--
-- Mirrored by `EntryType::kinds()` in `src/chain.rs`. A lookup TABLE was
-- considered and rejected in 0009 and is still rejected: it would be a second
-- place for the pairing to drift from the code, and a `CHECK` is the half that
-- binds a statement this server never issued.
--
-- ---------------------------------------------------------------------------
-- C. EXTENDING THIS LATER -- THE PATH, SO NOBODY HAS TO GUESS IT
-- ---------------------------------------------------------------------------
--
-- The vault order adds `vault_key_enrolled`, `vault_shared`, `vault_read`,
-- `vault_mode_changed` and others to the `org` branch; §7.2 lists thirty more
-- for the `site` branch. A later migration extends this by:
--
--   ALTER TABLE chain_entries NO FORCE ROW LEVEL SECURITY;
--   ALTER TABLE chain_entries DROP CONSTRAINT chain_entries_type_belongs_to_kind;
--   ALTER TABLE chain_entries ADD  CONSTRAINT chain_entries_type_belongs_to_kind CHECK (...);
--   ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
--
-- DROP then ADD, never an edit to this file: 0010 is applied to real databases
-- and `migrate::checksum` refuses an applied migration that has been edited --
-- including a comment-only edit, because the checksum is over the file's bytes.
--
-- ---------------------------------------------------------------------------
-- D. INVARIANT 11, AND WHY THE PAIR IS HERE
-- ---------------------------------------------------------------------------
--
-- `.context/conventions.md` invariant 11: a migration that READS an existing
-- table must handle forced row-level security, because a migration runs with no
-- tenant context and a read behind `FORCE ROW LEVEL SECURITY` returns zero rows
-- SILENTLY. `ADD CONSTRAINT ... CHECK` re-validates every row already in
-- `chain_entries`, and that validating scan is a read of a table that is behind
-- `FORCE` -- so the pair below is what makes the validation see the rows it is
-- supposed to be validating. **On an empty database the difference is
-- invisible**, which is exactly how 0009 shipped its foreign key and found the
-- same bug only against a seeded database. The pair is LOAD-BEARING and must
-- not be tidied away.
--
-- ---------------------------------------------------------------------------
-- E. TWO SENTENCES IN 0009'S HEADER ARE WRONG, AND ARE CORRECTED HERE
-- ---------------------------------------------------------------------------
--
-- They cannot be corrected in place: `migrate::run` compares a recorded
-- checksum against the embedded file's bytes and refuses an applied migration
-- that has been edited at all, comments included. So the corrections live here,
-- and a reader of 0009 who follows its own header to this file finds them.
--
--   * 0009 line ~65 -- "`metadata_stored` is THE BYTES IN THE COLUMN --
--     canonical plaintext on a design or site chain, the AEAD blob on an
--     organisation chain." **Wrong about the site chain.** Site metadata is
--     AEAD ciphertext, under the key derived at
--     `fathom/chain/key/site-metadata/v1`; 0009's own constraint
--     `chain_entries_metadata_framing_matches_kind` requires a 12-byte
--     `metadata_nonce` on every site row and would refuse a plaintext one.
--     Correct: canonical plaintext on a DESIGN chain, the AEAD blob on a SITE
--     or ORGANISATION chain.
--   * 0009 line ~320 -- of `metadata_binding`: "On a design or site chain the
--     plaintext is in `metadata` beside it, so this is checkable with the chain
--     key alone; on an organisation chain it is what a deep run re-derives
--     after decrypting." **Wrong in the same way.** Correct: on a DESIGN chain
--     the plaintext is in `metadata` beside it, so the binding is checkable on
--     a links-only run; on a SITE or an ORGANISATION chain it is what a DEEP
--     run re-derives after decrypting. The asymmetry that remains true is
--     about the KEY, not about the ciphertext: a verifier holding
--     `chain_master` can derive the site metadata key and cannot derive an
--     organisation content key, which is wrapped under the tenant key.
--
-- Everything else in 0009's header stands, including its statement of what a
-- dump with no key still discloses.

ALTER TABLE chain_entries NO FORCE ROW LEVEL SECURITY;

-- Dropped by name if some database already carries one under this name --
-- none should, since this is the migration that creates it, but a DROP that
-- is a no-op costs nothing and makes re-running against a hand-patched
-- database deterministic.
ALTER TABLE chain_entries
    DROP CONSTRAINT IF EXISTS chain_entries_type_belongs_to_kind;

ALTER TABLE chain_entries
    ADD CONSTRAINT chain_entries_type_belongs_to_kind
    CHECK (
        (chain_kind = 'design'
             AND entry_type IN ('create', 'update', 'reencrypt'))
     OR (chain_kind = 'site'
             AND entry_type IN ('deployment_started', 'shipper_gap',
                                'spool_pressure', 'rewrap'))
     OR (chain_kind = 'org'
             AND entry_type IN ('org_genesis', 'rewrap'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- F. THE ONE ENUMERATION A DEPLOYMENT-WIDE RE-WRAP NEEDS
--
-- §12.6's re-wrap changes the master key, and there is one active master key
-- per DATABASE. So the operation is deployment-wide by construction: it must
-- re-wrap every row that is wrapped directly under the master key, for every
-- tenant, or the tenants it skipped are openable under neither key --
-- `keys::rewrap_tenant_keys` did exactly that until 2026-09-12, retiring the
-- deployment's master key and re-wrapping one organisation's rows.
--
-- To re-wrap every tenant it has to ENUMERATE them, and `tenant_keys` is
-- behind `FORCE ROW LEVEL SECURITY` keyed on `app.tenant_id`: with no tenant
-- set, the runtime role sees zero rows, silently. That is invariant 11's shape
-- at runtime rather than in a migration, and the answer is not to drop the
-- policy.
--
-- **A SELECT-only policy, for the runtime role only, gated on an explicit
-- setting.** Exactly the shape `app.design_capability` already has in 0007:
-- the setting is turned on by one function
-- (`repo::open_key_custody_context`), for the length of one transaction, and
-- `set_config(..., true)` means it cannot outlive it. What this adds and what
-- it does not:
--
--   * It adds ENUMERATION -- the ability to learn which organisations have key
--     rows at all. The runtime role could already read any single tenant's
--     rows by setting `app.tenant_id` to that tenant's id, because
--     `set_config` needs no privilege; RLS here is the second half of §7's
--     "both, neither alone", and the half that actually pins the tenant is
--     `repo::TenantContext` in application code.
--   * It adds NO ability to unwrap anything. Every row this exposes is a
--     wrapped key whose wrapping key is the master key, which is not in this
--     database and never will be (ADR-0043 §1).
--   * It is `FOR SELECT` and `TO fathom_app`. The UPDATE half of a re-wrap
--     runs per organisation under `tenant_keys_updatable` with `app.tenant_id`
--     set, so no write policy is added here at all. `fathom_operator` gains
--     nothing: §1.3 keeps the operator plane away from key material entirely,
--     and it holds no privilege on this table.
-- ---------------------------------------------------------------------------
CREATE POLICY tenant_keys_enumerable_for_key_custody ON tenant_keys
    FOR SELECT TO fathom_app
    USING (current_setting('app.key_custody', true) = 'yes');
