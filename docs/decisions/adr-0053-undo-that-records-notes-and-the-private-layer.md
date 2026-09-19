# ADR-0053 — Undo that records, notes on equipment, and where the private layer lives

**Status:** accepted 2026-09-19 on the owner's "continue" over the Session 6(d) plan.
**Binds with:** ADR-0046 §6–§7 (undo records, notes are schema additions), ADR-0041 (typed is
marked, never refused), ADR-0052 (the gate runs in the browser). **Reopens on merit:** the
private-notes half of OPEN-QUESTIONS D2.

## Undo

1. **An undo is a new batch of reversing operations**, labelled "undo of <label>", recorded and
   saved like any change; redo is the undo of that. Adding is reversed by a tombstone; a field
   change by a field change back to the prior presence and value, superseding; a tombstone by a
   fifth operation, **revive**, because the engine refuses a reused id and re-adding under a new
   id would lose identity, history and the capture links. Revive re-runs the same containment
   check an add does, so a revived edge passes only if nothing replaced it.
2. **The client archives a replaced field into history** the way the engine does, so the prior
   value exists when an undo asks for it. It did not; a value was gone the moment it was edited.
3. **You undo your own changes.** The sign-in answer gains the account id, the client stamps it as
   the actor on every change, and the all-zero placeholder stays as the read-side sentinel; a
   batch it stamped is not undoable and the chip says why. A colleague's batch in between on any
   element the undo touches is a refusal wash naming that change, never a silent overwrite.
4. **The trail beside the drawing is the document's batches**, who and when from provenance,
   sealed when present in the last version opened or saved, pending otherwise. The server's
   history stays one row per version. **A comment on a pending change is a batch field**, with a
   second field linking an undo to what it reverses; both optional on the wire, omitted when
   empty, no face bump.

## Notes

5. **A note is a node, not a field.** Kind `Note` in schema 0.10 with the text, how it arrived
   (typed or pasted) and, for a paste, its line count; owned through a class `Notable` of Device,
   PhysicalPort and Rack by a containment edge `HasNote`. Device, not Chassis: the device has the
   page, the hostname and the capture. The rack's deliberate "no notes field" stays true.
6. **Pasted note text goes through the gate** by a module door, `OP_REDACT_TEXT`, backed by an
   ingest entry that runs the pipeline's framing, lexing, shaping and redaction and stops before
   binding; the door never writes the graph, the client writes the note with the returned text.
   Typed text is stored as typed and the editor says: Fathom does not redact what you type, only
   what you paste.

## The private layer

7. **A private note inside the shared sealed payload is readable by anyone who can open the
   design, so it is not private.** D2 asked for a private layer from the first schema with notes;
   the schema carries notes from 0.10, and the private layer is a per-account side payload sealed
   under account keys the vault does not have yet. It arrives with the vault, never as a flag in
   the shared payload. Shared notes only in 6(d).

## Consequences

Schema 0.10; a fifth operation on the wire and two optional batch keys; the session answer gains
one field. Proofs: the trail showing the undo above the change with both standing, a note pasted
with a real-length credential showing the block and the save body free of it, a colleague's
change refusing an undo by name, a typed note saying it was stored as typed.
