-- 0070 -- a firmware image keeps the name its file had, when Fathom cleaned it.
--
-- `filename` stays to letters, digits, dot, dash and underscore (it is pasted into a
-- device's command line). A browser that picks a file whose own name holds anything
-- else now cleans the name instead of refusing it, and sends the original along so the
-- staging record and its sealed `firmware_staged` entry say what the file was called.
--
-- It is the operator's own label for a public vendor file, shown back as text and
-- never joined to a path or a command. Optional, at most 1024 bytes, no control
-- characters, and never the same as `filename` (then nothing was renamed). The app
-- role may INSERT it and, like platform and version, may not UPDATE it.

ALTER TABLE firmware_images
    ADD COLUMN IF NOT EXISTS renamed_from text
        CHECK (octet_length(renamed_from) BETWEEN 1 AND 1024
               AND renamed_from !~ '[[:cntrl:]]'
               AND renamed_from <> filename);
