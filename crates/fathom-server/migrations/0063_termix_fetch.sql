-- 0063 -- "Fetch from Termix", switched on by a steward (ADR-0080 decision 9; the owner, 1 November
-- 2026: "I don't mind as much though if fathom is reading stuff, I just didn't want it to read and
-- then make actions based on that").
--
-- A check step may offer Fetch from Termix: the person's browser asks Termix to run the step's own
-- command, only from a fixed read-only list per platform, and the answer goes through the redaction
-- gate in the browser like any paste. It is off unless a steward turns it on for the whole
-- organisation. One more column on `0056`'s `organisation_termix`: no row, or false, reads as off.
--
-- Like `0056`'s switch it is a product switch, not a security boundary: the read-only list and its
-- refusal in the browser are what keep a fetch to reading (`client/src/components/termix/readOnly.ts`).
-- Who turned it on or off is sealed on the organisation chain as `termix_access_set`, with `fetch`
-- in its metadata, so the chain's entry types do not change.

ALTER TABLE organisation_termix ADD COLUMN IF NOT EXISTS fetch_on boolean NOT NULL DEFAULT false;
GRANT UPDATE (fetch_on) ON organisation_termix TO fathom_app;
