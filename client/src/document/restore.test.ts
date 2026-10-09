import { describe, expect, it } from 'vitest';

import { createRack, placeChassis, removeChassis } from './commands';
import { setDeviceField } from './edit';
import { applyChange } from './change';
import { localEdit, openLive } from './liveDoc';
import { edgesIn, emptyDocument, findNode, formatNodeId, readDeviceFields, type Document } from './model';
import { restoreTo } from './restore';
import { newUlid } from './ulid';

const T0 = 1_700_000_000_000;
const ME = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const MODEL = {
  vendor: 'juniper',
  model: 'EX4300-48P',
  rackUnits: 1,
  reviewedBy: 'reviewer',
  source: { cite: 'cite', readOn: '2026-09-14' },
  psuSlots: [],
  faceplates: [{ face: 'front', portCount: 1, ports: [{ kind: 'RJ45', number: 0, uplink: false, row: 'single', column: 0, groupGapBefore: false }] }],
} as never;

function world() {
  const premisesId = formatNodeId('Premises', newUlid(T0));
  const empty: Document = { ...emptyDocument(), nodes: [{ id: premisesId, existence: newUlid(T0), fields: {} }] };
  const withRack = createRack(empty, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', actor: ME, now: T0 + 1 });
  const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
  const placed = placeChassis(withRack, rackId, MODEL, 4, 'front', { actor: ME, now: T0 + 2 });
  const chassisId = edgesIn(placed, rackId, 'MountedIn')[0].from;
  const deviceId = edgesIn(placed, chassisId, 'HasChassis')[0].from;
  return { base: placed, chassisId, deviceId };
}

describe('restoreTo', () => {
  it('is nothing when nothing differs', () => {
    const { base } = world();
    expect(restoreTo(base, base, 'x', { actor: ME, now: T0 + 9 })).toBe(base);
  });

  it('puts back a rename and a removed device with real ops a live session sends', () => {
    const { base, chassisId, deviceId } = world();
    const renamed = setDeviceField(base, deviceId, 'hostname', 'renamed', { actor: ME, now: T0 + 10 });
    const later = removeChassis(renamed, chassisId, { actor: ME, now: T0 + 20 });
    const back = restoreTo(later, base, 'Restored the save', { actor: ME, now: T0 + 30 });

    const batch = back.batches[back.batches.length - 1];
    expect(batch.ops.length).toBeGreaterThan(0);
    expect(findNode(back, chassisId)?.absentSince).toBeUndefined();
    expect(readDeviceFields(findNode(back, deviceId)!).hostname).toBe(readDeviceFields(findNode(base, deviceId)!).hostname);

    // Through a live session: the restore is sent, and a peer applying it lands on the same state.
    const edit = localEdit(openLive(later, 5), back);
    expect(edit.changes).toHaveLength(1);
    expect(edit.changes[0].batch.label).toBe('Restored the save');
    const peer = applyChange(later, edit.changes[0]);
    expect(findNode(peer, chassisId)?.absentSince).toBeUndefined();
    expect(readDeviceFields(findNode(peer, deviceId)!).hostname).toBe(readDeviceFields(findNode(base, deviceId)!).hostname);
  });
});
