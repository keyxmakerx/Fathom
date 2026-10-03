-- A design's name, encrypted (ADR-0060 step 3b). 0007 left the column out so a
-- plaintext name never became a second copy in rows or logs. These three hold
-- it sealed under the organisation content key (nonce, epoch kept per row).
-- All NULL means "Untitled design". No chain entry: a name is not content.
ALTER TABLE designs
    ADD COLUMN IF NOT EXISTS name_ciphertext bytea,
    ADD COLUMN IF NOT EXISTS name_nonce      bytea,
    ADD COLUMN IF NOT EXISTS name_key_epoch  integer,
    ADD CONSTRAINT designs_name_all_or_none CHECK (
        (name_ciphertext IS NULL AND name_nonce IS NULL AND name_key_epoch IS NULL)
        OR (name_ciphertext IS NOT NULL AND name_nonce IS NOT NULL AND name_key_epoch IS NOT NULL));
