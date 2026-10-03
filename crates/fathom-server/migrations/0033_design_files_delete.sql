-- Delete for good (docs files follow-up): the sealed bytes are overwritten with nothing and the
-- row stays as the record of who erased it and when. The graph keeps the name, size and SHA-256.
ALTER TABLE design_files ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE design_files ADD COLUMN IF NOT EXISTS deleted_by text REFERENCES accounts(id);
