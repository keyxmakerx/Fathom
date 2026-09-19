// ADR-0053 §4 — the Trail panel's own pure logic (`Trail.tsx`'s render only
// calls into this): which batches are redoable, and how each batch's own
// row reads. Kept apart from the component so it is testable without a DOM
// (this project's own precedent — `document/undo.ts`'s file header, and
// every other `*.test.ts` beside a pure module in this tree).

import { batchActor } from '../../document/undo';
import { decodeUlid } from '../../document/ulid';
import { LOCAL_ACTOR, type Batch, type Document } from '../../document/model';

/** The wall-clock millisecond a batch's own ulid was minted at —
 * `document/undo.ts`'s own private `ulidTimestampMs`, not exported there
 * (CLAUDE.md rule 3 does not apply to a wire helper, but the function itself
 * is `document/undo.ts`'s to own and not exported for reuse); mirrored here
 * rather than duplicated logic invented fresh — both read the same top 48
 * bits `ulid.ts`'s own file header documents. */
export function batchWhenMs(batchId: string): number {
  return Number(decodeUlid(batchId) >> 80n);
}

/** How many hops `batch` sits down its own `.reverses` chain — 0 for a
 * plain (never-reversing) batch, 1 for an undo of one, 2 for a redo of
 * THAT undo (which is, structurally, just another `.reverses`-carrying
 * batch — `reverseBatch`'s own doc, `document/undo.ts`: `undo` and `redo`
 * are the same mechanism, differing only in the label prefix), and so on.
 * Odd is "currently undone, waiting to be redone"; even (including 0) is
 * "currently at the original, nothing to redo" — the parity `redoable`
 * below reads off this to tell the two apart, since `Batch` itself carries
 * no "was this an undo or a redo" flag beyond its own label text. */
function reversalDepth(doc: Document, batch: Batch): number {
  let depth = 0;
  let current: Batch | undefined = batch;
  while (current?.reverses !== undefined) {
    depth += 1;
    current = doc.batches.find((b) => b.id === current!.reverses);
  }
  return depth;
}

/** ADR-0053 §1: "redo is the undo of that [undo]." The most recent batch,
 * stamped `accountId`, that nothing later has itself reversed, AND whose
 * own `reversalDepth` is odd — "currently undone." `undefined` when there
 * is nothing of the signed-in account's own left to redo, including right
 * after a redo itself (`reversalDepth` even again — see that function's own
 * doc): a redo is not itself further redoable, only undoable again, the
 * same ordinary way `document/undo.ts`'s own `undoable` already offers
 * every unreversed batch of an account's, redo batches included. */
export function redoable(doc: Document, accountId: string): Batch | undefined {
  const reversed = new Set(doc.batches.map((b) => b.reverses).filter((r): r is string => r !== undefined));
  for (let i = doc.batches.length - 1; i >= 0; i -= 1) {
    const batch = doc.batches[i];
    if (reversed.has(batch.id)) continue; // already redone, or itself reversed, by something later
    if (batch.reverses === undefined) continue; // a plain batch is never a redo candidate
    const actor = batchActor(doc, batch);
    if (actor === undefined || actor === LOCAL_ACTOR) continue;
    if (actor !== accountId) continue;
    if (reversalDepth(doc, batch) % 2 !== 1) continue; // even depth: already back at the original
    return batch;
  }
  return undefined;
}

/** ADR-0053 §4: "who and when from provenance" — the signed-in account's own
 * batches read by name (their own address, the one thing this client holds
 * for them, `state/sessionState.ts`'s own `ActiveSession.address`); anyone
 * else's by a short id, since this client has no directory of other
 * accounts' addresses to read a name from. `undefined`/`LOCAL_ACTOR` (a
 * mixed batch, or one pre-dating accounts entirely) reads as `'local'` —
 * true of the data, not a guess dressed as a name. */
export function whoLabel(actor: string | undefined, accountId: string | null, ownAddress: string | null): string {
  if (actor === undefined || actor === LOCAL_ACTOR) return 'local';
  if (accountId !== null && actor === accountId) return ownAddress ?? shortId(actor);
  return shortId(actor);
}

const SHORT_ID_CHARS = 8;

function shortId(id: string): string {
  return id.length <= SHORT_ID_CHARS ? id : id.slice(0, SHORT_ID_CHARS);
}

export interface TrailRow {
  batchId: string;
  whenMs: number;
  who: string;
  what: string;
  why: string | null;
  /** ADR-0053 §4: "sealed when present in the last version opened or
   * saved, pending otherwise." */
  sealed: boolean;
}

/** ADR-0053 §4: "the trail beside the drawing is the document's batches" —
 * newest first (`doc.batches` itself is oldest-first, `model.ts`'s own
 * `withBatch`, always appended), which is also what puts an undo's own
 * entry above the change it reverses without any extra sort: an undo batch
 * is always minted after the batch it reverses. */
export function trailRows(
  doc: Document,
  accountId: string | null,
  ownAddress: string | null,
  sealedBatchIds: ReadonlySet<string>,
): TrailRow[] {
  return [...doc.batches].reverse().map((batch) => ({
    batchId: batch.id,
    whenMs: batchWhenMs(batch.id),
    who: whoLabel(batchActor(doc, batch), accountId, ownAddress),
    what: batch.label,
    why: batch.comment ?? null,
    sealed: sealedBatchIds.has(batch.id),
  }));
}
