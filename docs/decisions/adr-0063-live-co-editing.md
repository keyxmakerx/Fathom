# ADR-0063: Live co-editing: the server applies and orders, the clients merge field by field

**Status:** proposed 2026-10-03; design thread approved 2026-10-03; revised after two opus review
passes the same day (server-held head, checkpoints by the server). Builds round 9's approval (ADR-0061, #99):
merge per field, put mine back, no locks, presence as an initials dot. Answers REBUILD-PLAN's open
question "who wins". Amends ADR-0054 §1 and §5 for live sessions.

## Correction to the brief

The brief said the server cannot read designs and changes travel sealed. It reads every payload
back and refuses credentials before storing it (ADR-0049 §2, `validate_payload`), and encrypts at
rest under a key it holds. A sealed change would skip that gate (rule 4). Live changes reach the
server in the clear over TLS, pass the same gate, and are stored encrypted. Rule 5 stays honoured.

## Decision

1. **Transport: signed requests up, one streamed response down.** No WebSocket, no new crate.
   - A change is a signed `POST …/designs/{d}/changes`: per-request signature and single-use nonce
     (`sessions.rs`), capability from `grants::authorise_account` in the transaction that writes
     it. Needs `draw`; a `read` holder cannot send.
   - The feed is a signed `GET …/designs/{d}/live?since=N` whose body streams (fetch with a reader;
     `EventSource` cannot sign). Needs `read`.
   - One stream per design per browser: the tab holding a Web Lock on the design opens it and
     shares it over `BroadcastChannel`; another tab takes over when it closes. The shipped server
     is HTTP/1.1 behind the operator's proxy (RUNNING-IT), so a stream per tab would exhaust the
     browser's six connections per host.
   - Heartbeat every 25 s and `X-Accel-Buffering: no`, so proxies neither buffer nor idle-close it.
   - Across server processes, `NOTIFY` carries only `(design, version)`; each process reads the row.
     One task per process holds `LISTEN` and drains it continuously, so the queue cannot back up.
2. **The unit is a change: one batch** (add node, add edge, set field, tombstone, revive, with the
   values and provenance), as a `fathom-change 1` canonical JSON document.
3. **The server applies every change to the design's head before accepting it.** Under the design's
   row lock it brings its head `Graph` to the current version (from the latest checkpoint or whole
   version plus the changes after it), applies the batch through `fathom-graph`'s own write path,
   and refuses whatever that path refuses: undeclared fields (rule 3), bad values, missing or
   wrong-kind endpoints, a second `MountedIn`, cycles, reused ids. It also refuses a credential in
   `Capture.text` or `Note.text` (the save gate's lines), any provenance or `by` naming anyone but
   the signed-in account, and a `reverses` naming another person's batch. Only then does the change
   take `version + 1`, a `change` chain entry, and an encrypted row in a new `design_change` table.
   The change is applied to a copy, swapped in only after commit. Heads are keyed by version and
   the tip chain seal, and rebuilt from storage on a miss or mismatch. They live on a few worker
   threads sharded by design (`Graph` is not `Send`), so a cold rebuild stalls only its own
   design, capped by bytes and evicted least recently used.
   The current version is the highest across `design_payload` and `design_change`.
4. **Ordering: the server's version is the only clock.** Clients never compare clocks. Every
   accepted change applies cleanly to the head, so every client applying them in version order
   converges. A gap makes the client re-ask from its last version.
5. **Merge, field by field.** Different fields always merge; on the same field the later version
   wins. The client keeps the confirmed document plus its pending changes replayed on top. A pending
   change the server refuses (its thing was removed, or it would break a rule above) is dropped and
   the person is told. History keeps every value.
6. **"Sam changed X just after you."** When a remote change overwrites a field you set in this
   sitting within the last 10 minutes, you see it at once with *Keep theirs* / *Put mine back*. Put
   mine back is a new change restoring your value. Undo skips any part another person has since
   changed, and says so.
7. **Rules across things are Checks.** Two devices in one U, or duplicate port labels, both apply
   and show as a Check. Graph rules (item 3) still refuse; local gestures still refuse as today.
8. **Checkpoints are written by the server, from its head.** After 100 changes, or when the last
   stream on a design closes, the server writes, under the account whose change or leaving
   triggered it, the head as a full face at version N into
   `design_checkpoint` (sealed, not a version, no chain entry: it is derived from chained data, and
   verify replays to check it). Open reads the newest checkpoint or whole version plus later
   changes, falling back to an older one if the newest will not load. `?version=N` replays to N.
   History lists every change with its author. Rotation re-encrypts changes and checkpoints in
   bounded batches under the audit spool limit.
9. **Idempotency.** `design_change` records `(design, batch_id, version, body digest)`, looked up
   only after authorisation. The same batch id with the same digest returns the stored version, so
   a lost answer never applies twice; with a different digest it is refused.
10. **Offline and rejoin.** Pending changes wait in memory, never in browser storage. On reconnect
    the client streams from its last version, replays, then sends. Arrival order decides; the
    overwritten person gets the notice. Closing a tab with pending changes warns as today.
11. **Without a live connection** a whole save names its base and is refused if anything landed
    since (ADR-0054). An accepted whole save replaces the head and streams as a reload; clients
    load it and replay their pending changes on top. A `read` holder receives every change, as `open` gives them the whole design.
12. **Presence: an initials dot, scoped to the view.** Dots in the bar, and a small ink initials
    dot at the top-right of the first thing each person has selected; it moves only when their
    selection changes. A signed `POST …/presence` needing `read`, bounded in size, at most 2 a second, expiring when the stream closes. A
    subscriber receives only the people in its own view. Changes reach everyone and carry their
    author.
13. **Authorization on the stream.** Any change to authority state, and a session's sign-out,
    revocation or disabling (not its per-request touch), sends a `NOTIFY`. After a `LISTEN`
    reconnect every stream re-checks, since notifications are lost while disconnected. Before every delivery the stream compares the organisation's authority head with the
    one it last checked and re-authorises if it moved; it closes on failure, so revocation, sign-out,
    disabling or suspension stop delivery at once (tested). Amends ADR-0054 §5 for streams: the
    check is per delivery against the authority head, not in the same transaction. A 15 s re-check
    backs it up. Streams end after 10 minutes and reopen signed. Background requests (stream, reopen,
    presence) do not refresh `last_seen_at`; the idle limit still ends an unattended session.
14. **Limits.** Per account: 2 streams per design, 8 in total; 20 changes a second, burst 30 (under
    the 32-nonce window). Per design: 50 streams. A change body of at most 4 MiB, parsed only after
    the signature verifies. A subscriber more than 8 MiB behind is closed and resyncs with `since`.
    Change writes count against the audit spool bound like any write; the rate limit keeps one
    person from filling it.

## Consequences

Each change costs a nonce round trip and a short locked transaction, so text sends on commit, not
per keystroke. The server holds decrypted heads in memory while a design is being edited, as it
already holds payloads briefly on open and save. A cold head costs one load and replay. One HTTP/1.1
connection per browser per open design.

## Wire (settled while building)

- **Change document:** `fathom-change 1`, then `schema <version>`, a blank line, then canonical
  JSON (`fathom-canon`): `{"batch": B, "provenance": [P…], "values": [V…]}`. `B` is one entry of
  the plain face's `batches`; `P` are the provenance records `B` introduces, ascending id; `values`
  holds one canonical value per `set_field` op whose presence is `set`, in op order. Applying it is
  `fathom_workspace::apply_change` in Rust and `applyChange` in `client/src/document/change.ts`;
  both are proved byte for byte against Rust-made vectors under `client/src/document/vectors/`.
- **POST `…/changes?after=N`:** body `u32_le(schema minor) ‖ change`; answers `version\n`, or a
  refusal naming the reason.
- **GET `…/live?since=N`:** frames of `u8 type ‖ u64_le version ‖ u32_le length ‖ bytes`. Types:
  1 change (a change document), 2 reload (a whole save landed at `version`), 3 presence (JSON
  list of the others in your view), 4 heartbeat, 5 resync (reopen from your last version).
- **POST `…/presence`:** body JSON `{"view": "canvas" | "inventory", "selected": <element id> | null}`,
  at most 256 bytes.
- **Presence frame (3):** `{"self": P, "others": [P…]}`, `P` = `{"account", "initials", "name"}`
  plus `selected` for others. **Author frame (6):** `P`, sent before the first change from an
  author the stream has not named yet.
