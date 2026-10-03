// One undo step for many commands (ADR-0053: undo reverses a batch). Commands each append a
// batch; this merges the ones appended between two documents into a single batch, so one undo()
// reverses them all and one redo() restores them. The merged batch keeps every op in order and
// every provenance record, so `undoable` sees the same one actor it would for any batch.

import { withBatch, type Batch, type Document } from './model';
import { LABEL_MAX_BYTES, batchActor, truncateUtf8 } from './undo';
import { newUlid } from './ulid';

export class CollapseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollapseError';
  }
}

/**
 * `after` must be `before` plus appended batches. Returns `after` with those batches replaced by
 * one labelled `label` (cut to the engine's 60-byte limit). Refuses if the batches were not made
 * by one actor, or if one of them is itself an undo or redo, since merging would hide that link.
 * No appended batch returns `after` unchanged.
 */
export function collapseBatches(before: Document, after: Document, label: string): Document {
  const n = before.batches.length;
  if (after.batches.length < n || before.batches.some((b, i) => after.batches[i]?.id !== b.id)) {
    throw new CollapseError('the later document does not continue the earlier one');
  }
  const added = after.batches.slice(n);
  if (added.length === 0) return after;
  if (added.some((b) => b.reverses !== undefined)) throw new CollapseError('an undo or redo cannot be merged into another change');
  const actors = new Set(added.map((b) => batchActor(after, b) ?? ''));
  const [actor] = actors;
  if (actors.size !== 1 || actor === '' || actor === undefined) throw new CollapseError('the batches were not all made by one account');
  const name = truncateUtf8(label.replace(/\s+/g, ' ').trim() || 'change', LABEL_MAX_BYTES);
  const merged: Batch = { id: newUlid(), label: name, ops: added.flatMap((b) => b.ops) };
  return withBatch({ ...after, batches: after.batches.slice(0, n) }, merged);
}
