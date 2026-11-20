// ADR-0053 §4 — the Trail panel's own pure logic (`Trail.tsx`'s render only
// calls into this): which batches are redoable, and how each batch's own
// row reads. Kept apart from the component so it is testable without a DOM
// (this project's own precedent — `document/undo.ts`'s file header, and
// every other `*.test.ts` beside a pure module in this tree).

import { batchActor, undoSteps } from '../../document/undo';
import { historyPartsOf } from '../design/changeToast';
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

/** ADR-0053 §1: "redo is the undo of that [undo]." The undo of `accountId`'s own that Redo takes back next,
 * `undefined` when there is none: nothing has been undone, every undo has been redone, or a change made since
 * has put the undone steps behind it (`document/undo.ts` `undoSteps`). */
export function redoable(doc: Document, accountId: string): Batch | undefined {
  return undoSteps(doc, accountId).redo[0];
}

/** ADR-0053 §4: "who and when from provenance". `nameOf` is the word every other history uses for a person
 * (`whoWord`, sign-off rua-ui-audit): "you", the name this design has heard for them, or "a colleague", and never
 * a piece of an account id. `undefined`/`LOCAL_ACTOR` (a mixed batch, or one pre-dating accounts entirely) reads
 * as `'local'` — true of the data, not a guess dressed as a name. */
export function whoLabel(actor: string | undefined, nameOf: (account: string) => string): string {
  if (actor === undefined || actor === LOCAL_ACTOR) return 'local';
  return nameOf(actor);
}

export interface TrailRow {
  batchId: string;
  whenMs: number;
  who: string;
  /** The account the change is attributed to, for the row to show on request. `null` when it is nobody's. */
  account: string | null;
  /** What changed, in History's words (`historyPartsOf`). */
  what: string;
  /** What it was changed on, where the words do not already say. */
  on: string | null;
  /** The label as it was recorded. */
  label: string;
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
export function trailRows(doc: Document, nameOf: (account: string) => string, sealedBatchIds: ReadonlySet<string>): TrailRow[] {
  const partsOf = historyPartsOf(doc);
  return [...doc.batches].reverse().map((batch) => {
    const actor = batchActor(doc, batch);
    const { said, to } = partsOf(batch);
    return {
      batchId: batch.id,
      whenMs: batchWhenMs(batch.id),
      who: whoLabel(actor, nameOf),
      account: actor === undefined || actor === LOCAL_ACTOR ? null : actor,
      what: said,
      on: to,
      label: batch.label,
      why: batch.comment ?? null,
      sealed: sealedBatchIds.has(batch.id),
    };
  });
}
