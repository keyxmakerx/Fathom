# ADR-0063: Live co-editing: the server orders, the clients merge field by field

**Status:** proposed 2026-10-03. Builds round 9's approval (ADR-0061, #99): merge per field, put
mine back, no locks, presence as an initials dot. Answers REBUILD-PLAN's open question "who wins".
Amends ADR-0054 §1 for live sessions.

## Correction to the brief

The brief says the server cannot read designs and changes travel sealed. That is not the system:
the server reads every payload back and refuses credentials before storing it (ADR-0049 §2,
`design_api.rs` `validate_payload`), and encrypts at rest under a key it holds. A sealed change
would skip that gate (rule 4). So live changes reach the server in the clear over TLS, pass the
same gate, and are stored encrypted, exactly like saves. Rule 5 stays honoured.

## Decision

1. **Transport: signed requests up, one streamed response down.** No WebSocket and no new crate.
   - A change is a signed `POST …/designs/{d}/changes`: the per-request signature, single-use
     nonce, and capability check every route already has (`sessions.rs`). Needs `draw`, checked in
     the transaction that writes it. A `read` holder cannot send.
   - The live feed is a signed `GET …/designs/{d}/live?since=N` whose response body streams
     (fetch with a reader; `EventSource` cannot sign). Needs `read`.
   - Across server processes, Postgres `NOTIFY` carries only `(design, version)`; each process
     reads the row and delivers it. No design data goes through `NOTIFY`.
2. **The unit is a change: one batch.** The ops `fathom-graph` already logs (add node, add edge,
   set field, tombstone, revive), the values they set, and their provenance, as a
   `fathom-change 1` canonical JSON document. The server reads it with a Rust reader beside
   `read_plain` and refuses: an id whose kind does not declare the field (schema, rule 3), a value
   the field's codec rejects, a credential in `Capture.text` or `Note.text` (the save gate's
   lines), a provenance or `by` naming anyone but the signed-in account (actor comes from the
   session), a batch id already in the design (a retry gets the stored version back, so a lost
   answer never applies twice).
3. **Ordering: the server's version number is the only clock.** Under the design's row lock a
   change takes `version + 1`, gets its chain entry, and is stored encrypted as a delta. Client
   clocks are never compared. Every client applies changes in version order with one
   deterministic `applyChange`, so all converge. A gap in versions makes the client re-ask from
   its last version.
4. **Merge, field by field.** Different fields always merge. On the same field the later version
   wins. The client keeps a confirmed document plus its own pending changes replayed on top; a
   remote change lands on the confirmed document and the pending ones replay. A pending change
   whose thing was removed meanwhile is dropped and the person is told. History keeps every value
   (the existing field archive).
5. **"Sam changed X just after you."** When a remote change overwrites a field whose value you set
   in this sitting, within the last 10 minutes, you see it at once with *Keep theirs* / *Put mine
   back*. Put mine back is a new change restoring your value from history. Undo never overwrites
   another person's later value: that part of the undo is skipped and said.
6. **Rules across things are not merge rules.** Two people filling the same U, or two ports with
   one label, both apply; the clash shows as a Check, not a refusal. Local gestures still refuse
   as today.
7. **Checkpoints.** Opening a design reads the latest full version plus the deltas after it. After
   100 deltas, or when the last person leaves, a client writes the full face as a checkpoint at
   the current version through the existing save checks (`read_plain`, credential gate,
   `base` = current). A checkpoint adds a chain entry, not a version.
8. **Offline and rejoin.** Pending changes wait in memory, never in browser storage (plaintext on
   disk). On reconnect the client streams from its last version, replays, then sends. Arrival
   order still decides, so an edit made offline and sent late wins, and the other person is told.
   Closing the tab with pending changes warns as today.
9. **Without a live connection** a save still names its base and is refused if anything landed
   since (ADR-0054). Read-only viewers stream the same changes through whatever filter `open`
   applies to them (bundle 2 strips config text); the stream never hands out more than `open`.
10. **Presence: an initials dot, scoped to the view.** The client posts its view (canvas, a rack,
    Inventory) on change. A subscriber receives only the people in its own view; in another rack
    you do not know they are there. Changes still reach everyone in the design, unattributed live.
11. **Authorization is re-checked.** Each change is a fresh signed request. A stream re-checks its
    session and capability every 15 s and at once when a grant changes in that organisation
    (`NOTIFY`), and closes on failure. Streams also end after 10 minutes and reopen signed.
12. **Limits per session:** 2 streams per design, 8 in total; a change body of at most 8 MiB;
    20 changes a second, burst 40; a subscriber more than 256 messages behind is closed and
    resyncs with `since`.

## Consequences

Each change costs a nonce round trip and a short transaction; fine at field-commit rate, not per
keystroke, so text is sent on commit (Enter or leaving the field). A hostile `draw` holder can
write a checkpoint that differs from the deltas, which is no more than a whole save can do today;
a server-side Rust replay that checks checkpoints is deferred until something server-side needs
the head. One streamed response holds one HTTP/1.1 connection per open design tab.
