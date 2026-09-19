// ADR-0053 §1/§4 — the fifth op (`revive`) and the two optional batch keys
// (`comment`, `reverses`) round-trip through the plain face byte for byte.
// Not named `plain.test.ts`: that file belongs to another agent's session in
// this worktree (per this session's own ownership split).

import { describe, expect, it } from 'vitest';

import { emptyDocument, formatEdgeId, formatNodeId, type Document } from './model';
import { readPlain, writePlain } from './plain';
import { newUlid } from './ulid';

const NOW = 1_700_000_000_000;

function sampleDoc(): Document {
  const rackId = formatNodeId('Rack', newUlid(NOW));
  const chassisId = formatNodeId('Chassis', newUlid(NOW));
  const mountedId = formatEdgeId('MountedIn', newUlid(NOW));
  const existenceProv = newUlid(NOW);
  const tombstoneAt = NOW + 1000;
  const reviveAt = NOW + 2000;

  const doc: Document = {
    ...emptyDocument(),
    nodes: [
      { id: rackId, existence: existenceProv, fields: {} },
      { id: chassisId, existence: existenceProv, fields: {}, absentSince: undefined },
    ],
    edges: [{ id: mountedId, from: chassisId, to: rackId, prov: existenceProv, fields: {} }],
    provenance: [
      {
        id: existenceProv,
        origin: { kind: 'hand' },
        assertedAt: NOW,
        assertedBy: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        confidence: 'asserted',
      },
    ],
    batches: [
      {
        id: newUlid(NOW),
        label: 'move chassis',
        ops: [{ type: 'tombstone', element: chassisId, at: tombstoneAt, by: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }],
      },
      {
        id: newUlid(reviveAt),
        label: 'undo of move chassis',
        comment: 'brought it back',
        reverses: 'not-a-real-batch-id-but-a-string',
        ops: [{ type: 'revive', element: chassisId, at: reviveAt, by: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }],
      },
    ],
  };
  return doc;
}

describe('ADR-0053 wire shapes round-trip through the plain face', () => {
  it('a document with a revive op and a commented, reversing batch reads and writes byte-identical', () => {
    const doc = sampleDoc();
    const bytes = writePlain(doc);
    const read = readPlain(bytes);
    expect(read).toEqual(doc);
    const rewritten = writePlain(read);
    expect(rewritten).toEqual(bytes);
  });

  it('a batch with neither comment nor reverses omits both keys on the wire', () => {
    const doc = sampleDoc();
    const bytes = writePlain(doc);
    const text = new TextDecoder().decode(bytes);
    const bodyLine = text.split('\n')[4];
    const firstBatch = JSON.parse(bodyLine).batches[0];
    expect('comment' in firstBatch).toBe(false);
    expect('reverses' in firstBatch).toBe(false);
  });
});
