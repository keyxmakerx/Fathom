import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../../api/catalogue';

import { emptyDocument } from '../../document/model';
import { viewOf } from '../../document/view';
import { addFreeBoxDoc, duplicateFreeDoc } from './freeActions';

const empty = () => emptyDocument();

const SRX: CatalogueModel = {
  vendor: 'juniper',
  model: 'SRX340',
  rackUnits: 1,
  reviewedBy: 'reviewer',
  source: { cite: 'cite', readOn: '2026-09-14' },
  psuSlots: [],
  faceplates: [
    {
      face: 'front',
      portCount: 2,
      ports: [
        { kind: 'RJ45', number: 0, uplink: false, row: 'single', column: 0, groupGapBefore: false },
        { kind: 'RJ45', number: 1, uplink: false, row: 'single', column: 1, groupGapBefore: false },
      ],
    },
  ],
};

describe('free actions', () => {
  it('adds a named switch with its ports, joined to another box, in one undo step', () => {
    const a = addFreeBoxDoc(empty(), 'router', 40, 40, undefined);
    const before = a.doc.batches.length;
    const b = addFreeBoxDoc(a.doc, 'switch', 200, 40, a.chassisId);
    expect(b.doc.batches.length).toBe(before + 1);
    const v = viewOf(b.doc, []);
    expect(v.free.map((f) => f.hostname).sort()).toEqual(['router-1', 'switch-1']);
    expect(v.free.find((f) => f.role === 'switch')?.portCount).toBeGreaterThan(0);
    expect(v.lines).toHaveLength(1);
  });

  it('keeps a catalogue model dropped off a rack, with its own ports, in one undo step', () => {
    const doc = empty();
    const a = addFreeBoxDoc(doc, null, 40, 40, undefined, undefined, SRX);
    expect(a.doc.batches.length).toBe(doc.batches.length + 1);
    const box = viewOf(a.doc, [SRX]).free[0]!;
    expect(box.model).toBe('SRX340');
    expect(box.portCount).toBe(2);
  });

  it('duplicates boxes with the line between them, offset and renamed', () => {
    const a = addFreeBoxDoc(empty(), 'router', 40, 40, undefined);
    const b = addFreeBoxDoc(a.doc, 'switch', 200, 40, a.chassisId);
    const view = viewOf(b.doc, []);
    const copy = duplicateFreeDoc(b.doc, view, [a.chassisId, b.chassisId], 24, 24);
    expect(copy.ids).toHaveLength(2);
    expect(copy.doc.batches.length).toBe(b.doc.batches.length + 1);
    const v = viewOf(copy.doc, []);
    expect(v.free).toHaveLength(4);
    expect(v.lines).toHaveLength(2);
    expect(v.free.find((f) => f.hostname === 'router-2')).toMatchObject({ x: 64, y: 64 });
  });
});
