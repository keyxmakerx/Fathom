-- 0068 -- The estate index's terms, findable by the thing they belong to (ADR-0089 §8.4).
--
-- `estate_terms` references `estate_rows` with ON DELETE CASCADE, and every rebuild of a design
-- deletes that design's rows. A cascade looks up the referencing rows by (organisation_id,
-- design_id, element_id), and the only index on `estate_terms` leads with (organisation_id,
-- term), so each deleted row read the organisation's whole term list. Measured 2026-11-02 on
-- PostgreSQL 16.15 with 1,000,000 devices and 20,000,000 terms: 3.1 s for each deleted row, so
-- about half an hour to rebuild a design of 1,000 devices; with this index, 20 ms for all 1,000.
-- PostgreSQL 16 documentation, 5.4.5 "Foreign Keys" (read 2026-11-02): a DELETE of a referenced
-- row "will require a scan of the referencing table for rows matching the old value, it is often a
-- good idea to index the referencing columns too", and the constraint does not create that index.
--
-- A plain CREATE INDEX, as migrations run in a transaction and before the server listens. It took
-- 17.7 s for 20,000,000 terms in the same test, and adds 241 MB there.

CREATE INDEX IF NOT EXISTS estate_terms_element_idx
    ON estate_terms (organisation_id, design_id, element_id);
