import { describe, expect, it } from 'vitest';

import type { Document } from '../../document/model';
import { oneUndoStep } from './RacksPlace';

const batch = (id: string) => ({ id, label: id, ops: [{ type: id } as never] });
const doc = (ids: string[]) => ({ batches: ids.map(batch) }) as unknown as Document;

describe('oneUndoStep', () => {
  it('folds the batches added after `from` into one, keeping earlier ones', () => {
    const out = oneUndoStep(doc(['a', 'b', 'c', 'd']), 1);
    expect(out.batches.map((b) => b.id)).toEqual(['a', 'b']);
    expect(out.batches[1]!.ops).toHaveLength(3);
  });
  it('leaves a single added batch alone', () => {
    const d = doc(['a', 'b']);
    expect(oneUndoStep(d, 1)).toBe(d);
  });
});
