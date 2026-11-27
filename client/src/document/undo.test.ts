import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../api/catalogue';
import { createRack, createSketchDevice, moveChassis, placeChassis, removeChassis, UnknownReferenceError } from './commands';
import { connectToOutside, setCableField } from './cables';
import { setDeviceField, setRackField } from './edit';
import { moveFree } from './freeform';
import { LOCAL_ACTOR, edgesIn, edgesOut, emptyDocument, findEdge, findNode, formatNodeId, readLayoutPinFields, type Document } from './model';
import { addNote, removeNote } from './notes';
import { setSupplyField } from './supplies';
import { newUlid } from './ulid';
import { UndoConflictError, batchActor, conflict, redo, redoSkipping, undo, undoSkipping, undoSteps, undoable } from './undo';

const NOW = 1_700_000_000_000;
const ACTOR_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ACTOR_B = '01ARZ3NDEKTSV4RRFFQ69G5FBV';

function docWithPremises(): { doc: Document; premisesId: string } {
  const premisesId = formatNodeId('Premises', newUlid(NOW));
  const doc: Document = {
    ...emptyDocument(),
    nodes: [
      {
        id: premisesId,
        existence: newUlid(NOW),
        fields: { 'Premises.label': { presence: 'set', prov: newUlid(NOW), value: 'Riverside CO' } },
      },
    ],
  };
  return { doc, premisesId };
}

function docWithRack(actor: string, now: number): { doc: Document; premisesId: string; rackId: string } {
  const { doc, premisesId } = docWithPremises();
  const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', actor, now });
  const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
  return { doc: withRack, premisesId, rackId };
}

const MODEL_1U: CatalogueModel = {
  vendor: 'juniper',
  model: 'EX4300-48P',
  rackUnits: 1,
  reviewedBy: 'reviewer',
  source: { cite: 'cite', readOn: '2026-09-14' },
  psuSlots: [],
  faceplates: [{ face: 'front', portCount: 1, ports: [{ kind: 'RJ45', number: 0, uplink: false, row: 'single', column: 0, groupGapBefore: false }] }],
};

const MODEL_WITH_PSU: CatalogueModel = {
  ...MODEL_1U,
  psuSlots: [{ name: 'PSU0', hotSwap: true, face: 'rear', position: { row: 'single', column: 0 } }],
};

describe('batchActor', () => {
  it('names the one actor every op in the batch shares', () => {
    const { doc } = docWithRack(ACTOR_A, NOW);
    expect(batchActor(doc, doc.batches[0])).toBe(ACTOR_A);
  });

  it('is undefined for a batch whose ops disagree (mixed)', () => {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    const mixed = {
      id: newUlid(NOW),
      label: 'mixed',
      ops: [
        { type: 'tombstone' as const, element: rackId, at: NOW, by: ACTOR_A },
        { type: 'tombstone' as const, element: rackId, at: NOW, by: ACTOR_B },
      ],
    };
    expect(batchActor(doc, mixed)).toBeUndefined();
  });
});

describe('undoable', () => {
  it('lists only the account\'s own batches, newest first', () => {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    const byB = setRackField(doc, rackId, 'row', 'Row A', { actor: ACTOR_B, now: NOW + 1 });
    const byA2 = setRackField(byB, rackId, 'bay', 1, { actor: ACTOR_A, now: NOW + 2 });

    const listA = undoable(byA2, ACTOR_A);
    expect(listA.map((b) => b.id)).toEqual([byA2.batches[2].id, byA2.batches[0].id]);

    const listB = undoable(byA2, ACTOR_B);
    expect(listB.map((b) => b.id)).toEqual([byA2.batches[1].id]);
  });

  it('lists neither a change that has been undone nor the undo of it', () => {
    const { doc } = docWithRack(ACTOR_A, NOW);
    const createBatchId = doc.batches[0].id;
    const undone = undo(doc, createBatchId, { actor: ACTOR_A, now: NOW + 1 });
    // The undo is a step forward (a redo), not a step back: listed here, a second Undo took back the first.
    expect(undoable(undone, ACTOR_A)).toEqual([]);
    expect(undoSteps(undone, ACTOR_A).redo.map((b) => b.id)).toEqual([undone.batches[1].id]);
  });

  it('never lists a LOCAL-stamped batch (nobody signed in wrote it)', () => {
    const { doc } = docWithRack(LOCAL_ACTOR, NOW);
    expect(undoable(doc, ACTOR_A)).toEqual([]);
    expect(undoable(doc, LOCAL_ACTOR)).toEqual([]);
  });
});

describe('undoSteps: Undo and Redo pressed several times', () => {
  // A rack dragged to three places, as the canvas saves it: one batch a drag, each writing the rack's pin.
  const PLACES = [{ x: -48, y: 80 }, { x: -96, y: 136 }, { x: -64, y: 208 }];
  function dragged(): { doc: Document; rackId: string } {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    let working = doc;
    PLACES.forEach((at, i) => {
      working = moveFree(working, [{ id: rackId, ...at }], { actor: ACTOR_A, now: NOW + 1 + i });
    });
    return { doc: working, rackId };
  }
  /** Where the rack's pin says it is; `null` with no pin, when it stands in its bay. */
  const at = (doc: Document, rackId: string): { x: number; y: number } | null => {
    const edge = edgesOut(doc, rackId, 'HasLayoutPin')[0];
    const pin = edge ? findNode(doc, edge.to) : undefined;
    if (!pin || pin.absentSince !== undefined) return null;
    const { x, y } = readLayoutPinFields(pin);
    return x === undefined || y === undefined ? null : { x, y };
  };
  let clock = NOW + 100;
  /** One press, as the bar makes it: the first step of its kind, or nothing when there is none. */
  const press = (doc: Document, key: 'undo' | 'redo'): Document => {
    const step = undoSteps(doc, ACTOR_A)[key][0];
    clock += 1;
    return step == null ? doc : (key === 'undo' ? undo : redo)(doc, step.id, { actor: ACTOR_A, now: clock });
  };

  it('goes one change further back at every Undo, to the start', () => {
    const { doc, rackId } = dragged();
    const one = press(doc, 'undo');
    expect(at(one, rackId)).toEqual(PLACES[1]);
    const two = press(one, 'undo');
    // Not back at the third place: the second Undo takes the second drag, not the first Undo.
    expect(at(two, rackId)).toEqual(PLACES[0]);
    const three = press(two, 'undo');
    expect(at(three, rackId)).toBeNull();
    // The rack's creation is the one step left, and then there is none.
    expect(undoable(three, ACTOR_A).map((b) => b.label)).toEqual(['create rack']);
    const four = press(three, 'undo');
    expect(undoable(four, ACTOR_A)).toEqual([]);
    expect(press(four, 'undo')).toBe(four);
  });

  it('comes forward again one change at every Redo, oldest undone first', () => {
    const { doc, rackId } = dragged();
    const back = press(press(press(doc, 'undo'), 'undo'), 'undo');
    const one = press(back, 'redo');
    expect(at(one, rackId)).toEqual(PLACES[0]);
    const two = press(one, 'redo');
    expect(at(two, rackId)).toEqual(PLACES[1]);
    const three = press(two, 'redo');
    expect(at(three, rackId)).toEqual(PLACES[2]);
    expect(undoSteps(three, ACTOR_A).redo).toEqual([]);
    expect(press(three, 'redo')).toBe(three);
    // And back again from there: a change that was undone and redone is a step back like any other.
    expect(at(press(three, 'undo'), rackId)).toEqual(PLACES[1]);
    expect(at(press(press(three, 'undo'), 'undo'), rackId)).toEqual(PLACES[0]);
  });

  it('has nothing to redo after a new change, and Undo then takes that change first', () => {
    const { doc, rackId } = dragged();
    const back = press(press(doc, 'undo'), 'undo');
    expect(undoSteps(back, ACTOR_A).redo).toHaveLength(2);
    const moved = moveFree(back, [{ id: rackId, x: 400, y: 16 }], { actor: ACTOR_A, now: NOW + 500 });
    expect(undoSteps(moved, ACTOR_A).redo).toEqual([]);
    // Redo once reached behind the new change for the older undo, and the rack went where it had never been dropped.
    expect(press(moved, 'redo')).toBe(moved);
    const one = press(moved, 'undo');
    expect(at(one, rackId)).toEqual(PLACES[0]);
    expect(at(press(one, 'undo'), rackId)).toBeNull();
  });

  it("leaves a colleague's changes out of both lists, and keeps one's own steps across them", () => {
    const { doc, rackId } = dragged();
    const one = press(doc, 'undo');
    const theirs = setRackField(one, rackId, 'row', 'Row B', { actor: ACTOR_B, now: NOW + 600 });
    const mine = undoSteps(theirs, ACTOR_A);
    expect(mine.undo.map((b) => b.label)).toEqual(['move', 'move', 'create rack']);
    expect(mine.redo.map((b) => b.label)).toEqual(['undo of move']);
    expect(undoSteps(theirs, ACTOR_B).undo.map((b) => b.label)).toEqual(['set Rack.row']);
    expect(undoSteps(theirs, ACTOR_B).redo).toEqual([]);
  });

  it('reads a document an older client took back and forth as the two steps it is', () => {
    // Undo pressed three times by a client that listed an undo as the next thing to undo:
    // undo, undo of that undo, undo of that again. The third drag is undone, and that is all.
    const { doc, rackId } = dragged();
    const u1 = undo(doc, doc.batches.at(-1)!.id, { actor: ACTOR_A, now: NOW + 700 });
    const u2 = undo(u1, u1.batches.at(-1)!.id, { actor: ACTOR_A, now: NOW + 701 });
    const u3 = undo(u2, u2.batches.at(-1)!.id, { actor: ACTOR_A, now: NOW + 702 });
    expect(at(u3, rackId)).toEqual(PLACES[1]);
    const steps = undoSteps(u3, ACTOR_A);
    expect(steps.redo.map((b) => b.id)).toEqual([u3.batches.at(-1)!.id]);
    expect(steps.undo.map((b) => b.id)).toEqual([doc.batches[2].id, doc.batches[1].id, doc.batches[0].id]);
    expect(at(press(u3, 'undo'), rackId)).toEqual(PLACES[0]);
    expect(at(press(u3, 'redo'), rackId)).toEqual(PLACES[2]);
  });

  it('counts a reversal of a step that is no longer one as a change of its own', () => {
    // An older client's Redo reached behind a newer change for an undo that change had put away.
    const { doc, rackId } = dragged();
    const undone = press(doc, 'undo');
    const undoId = undone.batches.at(-1)!.id;
    const moved = moveFree(undone, [{ id: rackId, x: 400, y: 16 }], { actor: ACTOR_A, now: NOW + 800 });
    const reached = redo(moved, undoId, { actor: ACTOR_A, now: NOW + 801 });
    const steps = undoSteps(reached, ACTOR_A);
    expect(steps.undo[0]!.id).toBe(reached.batches.at(-1)!.id);
    expect(steps.redo).toEqual([]);
  });
});

describe('undo — the reversal table', () => {
  it('add_node / add_edge -> tombstone (undoing "create rack")', () => {
    const { doc, rackId, premisesId } = docWithRack(ACTOR_A, NOW);
    const hasRack = edgesIn(doc, rackId, 'HasRack')[0];
    const createBatchId = doc.batches[0].id;

    const undone = undo(doc, createBatchId, { actor: ACTOR_A, now: NOW + 5 });

    expect(findNode(undone, rackId)!.absentSince).toBe(NOW + 5);
    expect(findEdge(undone, hasRack.id)!.absentSince).toBe(NOW + 5);
    // Every field this batch set is gone (first assertion -> 'unknown').
    expect(findNode(undone, rackId)!.fields).toEqual({});

    const undoBatch = undone.batches.at(-1)!;
    expect(undoBatch.label).toBe('undo of create rack');
    expect(undoBatch.reverses).toBe(createBatchId);
    expect(undoBatch.ops.map((o) => o.type)).toEqual(['tombstone', 'set_field', 'set_field', 'set_field', 'tombstone']);
    expect(undoBatch.ops[0]).toMatchObject({ element: hasRack.id });
    expect(undoBatch.ops.at(-1)).toMatchObject({ element: rackId });

    // Untouched: the premises this rack hung off.
    expect(findNode(undone, premisesId)!.absentSince).toBeUndefined();
  });

  it('set_field -> set_field, to the prior presence and value, superseding', () => {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    const once = setRackField(doc, rackId, 'row', 'Row A', { actor: ACTOR_A, now: NOW + 1 });
    const twice = setRackField(once, rackId, 'row', 'Row B', { actor: ACTOR_A, now: NOW + 2 });
    const secondBatchId = twice.batches[2].id;
    const liveProvBeforeUndo = findNode(twice, rackId)!.fields['Rack.row'].prov;

    const undone = undo(twice, secondBatchId, { actor: ACTOR_A, now: NOW + 3 });

    const field = findNode(undone, rackId)!.fields['Rack.row'];
    expect(field).toMatchObject({ presence: 'set', value: 'Row A' });
    const newProv = undone.provenance.find((p) => p.id === field.prov)!;
    expect(newProv.supersedes).toBe(liveProvBeforeUndo);

    // The value just replaced (Row B) is itself archived.
    const history = undone.history.find((h) => h.element === rackId && h.field === 'Rack.row')!;
    expect(history.entries.at(-1)).toEqual({ presence: 'set', prov: liveProvBeforeUndo, value: 'Row B' });

    const undoBatch = undone.batches.at(-1)!;
    expect(undoBatch.label).toBe('undo of set Rack.row');
    expect(undoBatch.reverses).toBe(secondBatchId);
  });

  it('tombstone -> revive (undoing removeChassis)', () => {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    const placed = placeChassis(doc, rackId, MODEL_1U, 1, 'front', { actor: ACTOR_A, now: NOW + 1 });
    const mounted = edgesIn(placed, rackId, 'MountedIn')[0];
    const chassisId = mounted.from;
    const removed = removeChassis(placed, chassisId, { actor: ACTOR_A, now: NOW + 2 });
    const removeBatchId = removed.batches.at(-1)!.id;
    expect(findNode(removed, chassisId)!.absentSince).toBe(NOW + 2);

    const revived = undo(removed, removeBatchId, { actor: ACTOR_A, now: NOW + 3 });

    expect(findNode(revived, chassisId)!.absentSince).toBeUndefined();
    const undoBatch = revived.batches.at(-1)!;
    expect(undoBatch.ops.every((o) => o.type === 'revive')).toBe(true);
    expect(undoBatch.reverses).toBe(removeBatchId);
  });

  it('redo is the undo of the undo', () => {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    const createBatchId = doc.batches[0].id;
    const undone = undo(doc, createBatchId, { actor: ACTOR_A, now: NOW + 1 });
    const undoBatchId = undone.batches.at(-1)!.id;

    const redone = redo(undone, undoBatchId, { actor: ACTOR_A, now: NOW + 2 });

    expect(findNode(redone, rackId)!.absentSince).toBeUndefined();
    const redoBatch = redone.batches.at(-1)!;
    expect(redoBatch.label).toBe('redo of undo of create rack');
    expect(redoBatch.reverses).toBe(undoBatchId);
  });

  it('the label is cut on a character boundary at the 60-byte limit', () => {
    const { doc, premisesId } = docWithPremises();
    const longLabel = 'a'.repeat(80);
    const batch = { id: newUlid(NOW), label: longLabel, ops: [{ type: 'tombstone' as const, element: premisesId, at: NOW, by: ACTOR_A }] };
    const withOneBatch: Document = { ...doc, batches: [batch] };
    const undone = undo(withOneBatch, batch.id, { actor: ACTOR_A, now: NOW + 1 });
    const label = undone.batches.at(-1)!.label;
    expect(new TextEncoder().encode(label).length).toBeLessThanOrEqual(60);
    expect(label.startsWith('undo of ')).toBe(true);
  });
});

describe('conflict', () => {
  it('is undefined when nothing later touched the same element', () => {
    const { doc } = docWithRack(ACTOR_A, NOW);
    expect(conflict(doc, doc.batches[0].id)).toBeUndefined();
  });

  it('names a later batch by another actor that touched the same element', () => {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    const createBatchId = doc.batches[0].id;
    const byB = setRackField(doc, rackId, 'row', 'Row A', { actor: ACTOR_B, now: NOW + 1 });
    const byBBatch = byB.batches[1];

    const result = conflict(byB, createBatchId);
    expect(result).toEqual({ kind: 'later-change', batchId: byBBatch.id, label: byBBatch.label, actor: ACTOR_B, at: NOW + 1, element: rackId });

    expect(() => undo(byB, createBatchId, { actor: ACTOR_A, now: NOW + 2 })).toThrow(UndoConflictError);
  });

  it('does not conflict on a later change by the SAME actor', () => {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    const createBatchId = doc.batches[0].id;
    const byA2 = setRackField(doc, rackId, 'row', 'Row A', { actor: ACTOR_A, now: NOW + 1 });
    expect(conflict(byA2, createBatchId)).toBeUndefined();
  });

  it('a LOCAL-stamped batch refuses with its own reason', () => {
    const { doc } = docWithRack(LOCAL_ACTOR, NOW);
    const batchId = doc.batches[0].id;
    expect(conflict(doc, batchId)).toEqual({ kind: 'unattributed' });
    expect(() => undo(doc, batchId, { actor: ACTOR_A, now: NOW + 1 })).toThrow(UndoConflictError);
  });

  it('throws UnknownReferenceError for a batch id this document has no batch for', () => {
    const { doc } = docWithRack(ACTOR_A, NOW);
    expect(() => conflict(doc, 'not-a-real-batch-id')).toThrow(UnknownReferenceError);
  });

  it('refuses undo of a batch stamped by a DIFFERENT actor than the one asking (not-yours)', () => {
    const { doc } = docWithRack(ACTOR_B, NOW);
    const createBatchId = doc.batches[0].id;
    expect(conflict(doc, createBatchId, ACTOR_A)).toEqual({ kind: 'not-yours', actor: ACTOR_B });
    expect(() => undo(doc, createBatchId, { actor: ACTOR_A, now: NOW + 1 })).toThrow(UndoConflictError);
  });

  it('does not conflict when the requesting actor owns the batch', () => {
    const { doc } = docWithRack(ACTOR_A, NOW);
    expect(conflict(doc, doc.batches[0].id, ACTOR_A)).toBeUndefined();
  });
});

// A live design skips a field someone else has written since (ADR-0063 §6). Skipping answers for a field the undo
// would write back. It once stood in for a refusal everywhere, so taking back an add removed the thing with a
// colleague's edit on it, and said nothing.
describe('undo in a live design — a thing someone else has changed is not removed', () => {
  function placed(): { doc: Document; rackId: string; placeId: string; chassisId: string; deviceId: string } {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    const withDevice = placeChassis(doc, rackId, MODEL_1U, 1, 'front', { actor: ACTOR_A, now: NOW + 1 });
    const chassisId = edgesIn(withDevice, rackId, 'MountedIn')[0].from;
    return { doc: withDevice, rackId, placeId: withDevice.batches.at(-1)!.id, chassisId, deviceId: edgesIn(withDevice, chassisId, 'HasChassis')[0].from };
  }

  function refusal(run: () => unknown): UndoConflictError['conflict'] {
    try {
      run();
    } catch (error) {
      if (error instanceof UndoConflictError) return error.conflict;
      throw error;
    }
    throw new Error('went through');
  }

  it('refuses to take back a placing once someone else has named the device', () => {
    const { doc, placeId, deviceId } = placed();
    const named = setDeviceField(doc, deviceId, 'hostname', 'sw-01', { actor: ACTOR_B, now: NOW + 2 });

    const c = refusal(() => undoSkipping(named, placeId, { actor: ACTOR_A, now: NOW + 3 }));
    expect(c).toMatchObject({ kind: 'later-change', actor: ACTOR_B, element: deviceId, batchId: named.batches.at(-1)!.id });
    expect(findNode(named, deviceId)!.absentSince).toBeUndefined();
  });

  it('refuses to take back a placing once someone else has moved the device', () => {
    const { doc, rackId, placeId, chassisId } = placed();
    const moved = moveChassis(doc, chassisId, rackId, 7, 'front', { actor: ACTOR_B, now: NOW + 2 });

    const c = refusal(() => undoSkipping(moved, placeId, { actor: ACTOR_A, now: NOW + 3 }));
    expect(c).toMatchObject({ kind: 'later-change', actor: ACTOR_B, element: edgesOut(moved, chassisId, 'MountedIn')[0].id });
  });

  it('refuses to take a removal back again once someone else has named what it brought back', () => {
    const { doc, chassisId, deviceId } = placed();
    const removed = removeChassis(doc, chassisId, { actor: ACTOR_A, now: NOW + 2 });
    const back = undoSkipping(removed, removed.batches.at(-1)!.id, { actor: ACTOR_A, now: NOW + 3 }).doc;
    const undoId = back.batches.at(-1)!.id;
    const named = setDeviceField(back, deviceId, 'hostname', 'sw-01', { actor: ACTOR_B, now: NOW + 4 });

    const c = refusal(() => redoSkipping(named, undoId, { actor: ACTOR_A, now: NOW + 5 }));
    expect(c).toMatchObject({ kind: 'later-change', actor: ACTOR_B, element: deviceId });
    expect(findNode(named, deviceId)!.absentSince).toBeUndefined();
  });

  it('still takes back a field of its own beside a field someone else wrote on the same thing', () => {
    const { doc, deviceId } = placed();
    const mine = setDeviceField(doc, deviceId, 'hostname', 'sw-01', { actor: ACTOR_A, now: NOW + 2 });
    const mineId = mine.batches.at(-1)!.id;
    const theirs = setDeviceField(mine, deviceId, 'management_address', '10.0.0.1', { actor: ACTOR_B, now: NOW + 3 });

    const r = undoSkipping(theirs, mineId, { actor: ACTOR_A, now: NOW + 4 });
    expect(r.skipped).toEqual([]);
    expect(findNode(r.doc, deviceId)!.fields['Device.hostname']).toBeUndefined();
    expect(findNode(r.doc, deviceId)!.fields['Device.management_address'].value).toBe('10.0.0.1');
  });

  it('still leaves a move someone else made after its own, and names it', () => {
    const { doc, rackId, chassisId } = placed();
    const mine = moveChassis(doc, chassisId, rackId, 3, 'front', { actor: ACTOR_A, now: NOW + 2 });
    const mineId = mine.batches.at(-1)!.id;
    const theirs = moveChassis(mine, chassisId, rackId, 7, 'front', { actor: ACTOR_B, now: NOW + 3 });

    const r = undoSkipping(theirs, mineId, { actor: ACTOR_A, now: NOW + 4 });
    expect(r.doc).toBe(theirs);
    expect(r.skipped.map((s) => s.key)).toContain('MountedIn.position_u');
    expect(r.skipped.every((s) => s.by === ACTOR_B)).toBe(true);
  });
});

describe('undo — ADR-0053 §3, the narrower rule: only what would take a colleague\'s work with it', () => {
  function placedAt(u: number): { doc: Document; rackId: string; placeId: string; chassisId: string; deviceId: string; portId: string } {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    const withDevice = placeChassis(doc, rackId, MODEL_1U, u, 'front', { actor: ACTOR_A, now: NOW + 1 });
    const chassisId = edgesIn(withDevice, rackId, 'MountedIn')[0].from;
    return {
      doc: withDevice,
      rackId,
      placeId: withDevice.batches.at(-1)!.id,
      chassisId,
      deviceId: edgesIn(withDevice, chassisId, 'HasChassis')[0].from,
      portId: edgesOut(withDevice, chassisId, 'HasPort')[0].to,
    };
  }

  it('lets you take back your device when a colleague placed another in other units of the same rack', () => {
    const { doc, rackId, placeId, chassisId } = placedAt(1);
    const theirs = placeChassis(doc, rackId, MODEL_1U, 20, 'front', { actor: ACTOR_B, now: NOW + 2 });
    expect(conflict(theirs, placeId, ACTOR_A)).toBeUndefined();
    const undone = undo(theirs, placeId, { actor: ACTOR_A, now: NOW + 3 });
    expect(findNode(undone, chassisId)!.absentSince).toBeDefined();
    // Theirs stays.
    expect(edgesIn(undone, rackId, 'MountedIn').filter((e) => e.absentSince === undefined)).toHaveLength(1);
  });

  it('lets you take a removal back when a colleague placed another device elsewhere in that rack', () => {
    const { doc, rackId, chassisId } = placedAt(1);
    const removed = removeChassis(doc, chassisId, { actor: ACTOR_A, now: NOW + 2 });
    const removeId = removed.batches.at(-1)!.id;
    const theirs = placeChassis(removed, rackId, MODEL_1U, 20, 'front', { actor: ACTOR_B, now: NOW + 3 });
    expect(conflict(theirs, removeId, ACTOR_A)).toBeUndefined();
    expect(findNode(undo(theirs, removeId, { actor: ACTOR_A, now: NOW + 4 }), chassisId)!.absentSince).toBeUndefined();
  });

  it('lets you put your own field back when a colleague wrote a note on that device', () => {
    const { doc, deviceId } = placedAt(1);
    const mine = setDeviceField(doc, deviceId, 'management_address', '10.0.0.2', { actor: ACTOR_A, now: NOW + 2 });
    const mineId = mine.batches.at(-1)!.id;
    const theirs = addNote(mine, deviceId, { text: 'uplink', how: 'typed', actor: ACTOR_B, now: NOW + 3 });
    expect(conflict(theirs, mineId, ACTOR_A)).toBeUndefined();
  });

  it('lets you take a cable off when a colleague wrote a note on one of its ports', () => {
    const { doc, portId } = placedAt(1);
    const cabled = connectToOutside(doc, portId, { label: 'to ISP' }, { actor: ACTOR_A, now: NOW + 2 });
    const cableId = cabled.batches.at(-1)!.id;
    const theirs = addNote(cabled, portId, { text: 'uplink, do not unplug', how: 'typed', actor: ACTOR_B, now: NOW + 3 });
    expect(conflict(theirs, cableId, ACTOR_A)).toBeUndefined();
  });

  it('still refuses when a colleague has written a note on the device you would remove', () => {
    const { doc, placeId, deviceId } = placedAt(1);
    const theirs = addNote(doc, deviceId, { text: 'mine now', how: 'typed', actor: ACTOR_B, now: NOW + 2 });
    expect(conflict(theirs, placeId, ACTOR_A)).toMatchObject({ kind: 'later-change', actor: ACTOR_B });
  });

  it('still refuses when a colleague has cabled to a port on the device you would remove', () => {
    const { doc, placeId, portId } = placedAt(1);
    const theirs = connectToOutside(doc, portId, { label: 'to ISP' }, { actor: ACTOR_B, now: NOW + 2 });
    expect(conflict(theirs, placeId, ACTOR_A)).toMatchObject({ kind: 'later-change', actor: ACTOR_B });
  });

  it('still refuses when a colleague has put a device in the rack you added', () => {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    const theirs = placeChassis(doc, rackId, MODEL_1U, 1, 'front', { actor: ACTOR_B, now: NOW + 2 });
    expect(conflict(theirs, doc.batches[0].id, ACTOR_A)).toMatchObject({ kind: 'later-change', actor: ACTOR_B });
  });

  it('still refuses when a colleague has written the very field you would put back', () => {
    const { doc, deviceId } = placedAt(1);
    const mine = setDeviceField(doc, deviceId, 'hostname', 'sw-01', { actor: ACTOR_A, now: NOW + 2 });
    const theirs = setDeviceField(mine, deviceId, 'hostname', 'sw-02', { actor: ACTOR_B, now: NOW + 3 });
    expect(conflict(theirs, mine.batches.at(-1)!.id, ACTOR_A)).toMatchObject({ kind: 'later-change', actor: ACTOR_B, element: deviceId });
  });
});

describe('undo — ADR-0053 §2, archived through every field-write module', () => {
  it('setSupplyField (supplies.ts): undo restores the prior value, not "unknown"', () => {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    const placed = placeChassis(doc, rackId, MODEL_WITH_PSU, 1, 'front', { actor: ACTOR_A, now: NOW + 1 });
    const mounted = edgesIn(placed, rackId, 'MountedIn')[0];
    const chassisId = mounted.from;
    const supplyId = edgesOut(placed, chassisId, 'FittedIn')[0].to;

    const once = setSupplyField(placed, supplyId, 'serial', 'SERIALAAA', { actor: ACTOR_A, now: NOW + 2 });
    const twice = setSupplyField(once, supplyId, 'serial', 'SERIALBBB', { actor: ACTOR_A, now: NOW + 3 });
    const secondBatchId = twice.batches.at(-1)!.id;

    const undone = undo(twice, secondBatchId, { actor: ACTOR_A, now: NOW + 4 });

    expect(findNode(undone, supplyId)!.fields['PowerSupply.serial']).toMatchObject({
      presence: 'set',
      value: 'SERIALAAA',
    });
  });

  it('setCableField (cables.ts): undo restores the prior value, not "unknown"', () => {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    const placed = placeChassis(doc, rackId, MODEL_1U, 1, 'front', { actor: ACTOR_A, now: NOW + 1 });
    const chassisId = edgesIn(placed, rackId, 'MountedIn')[0].from;
    const portId = edgesOut(placed, chassisId, 'HasPort')[0].to;
    const cabled = connectToOutside(placed, portId, { label: 'to ISP' }, { actor: ACTOR_A, now: NOW + 2 });
    const cableId = cabled.nodes.find((n) => n.id.startsWith('cable:'))!.id;

    const once = setCableField(cabled, cableId, 'label', 'LABEL-A', { actor: ACTOR_A, now: NOW + 3 });
    const twice = setCableField(once, cableId, 'label', 'LABEL-B', { actor: ACTOR_A, now: NOW + 4 });
    const secondBatchId = twice.batches.at(-1)!.id;

    const undone = undo(twice, secondBatchId, { actor: ACTOR_A, now: NOW + 5 });

    expect(findNode(undone, cableId)!.fields['Cable.label']).toMatchObject({ presence: 'set', value: 'LABEL-A' });
  });
});

describe('undo — ADR-0053 §1, revive re-runs the same check an add does', () => {
  it('refuses reviving a MountedIn edge whose rack unit was retaken (single actor, conflict() silent)', () => {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    const placed1 = placeChassis(doc, rackId, MODEL_1U, 12, 'front', { actor: ACTOR_A, now: NOW + 1 });
    const chassis1 = edgesIn(placed1, rackId, 'MountedIn')[0].from;
    const removed = removeChassis(placed1, chassis1, { actor: ACTOR_A, now: NOW + 2 });
    const removeBatchId = removed.batches.at(-1)!.id;
    const placed2 = placeChassis(removed, rackId, MODEL_1U, 12, 'front', { actor: ACTOR_A, now: NOW + 3 });

    expect(conflict(placed2, removeBatchId)).toBeUndefined(); // same actor throughout — the two-rule check is silent
    expect(() => undo(placed2, removeBatchId, { actor: ACTOR_A, now: NOW + 4 })).toThrow(UndoConflictError);

    // Refused, not partially applied: the first chassis stays gone, the second stays live.
    expect(findNode(placed2, chassis1)!.absentSince).toBe(NOW + 2);
    expect(edgesIn(placed2, rackId, 'MountedIn')).toHaveLength(1);
  });

  it('refuses reviving a HasNote edge whose owner is (still) tombstoned', () => {
    const { doc, rackId } = docWithRack(ACTOR_A, NOW);
    const placed = placeChassis(doc, rackId, MODEL_1U, 1, 'front', { actor: ACTOR_A, now: NOW + 1 });
    const chassisId = edgesIn(placed, rackId, 'MountedIn')[0].from;
    const deviceId = edgesIn(placed, chassisId, 'HasChassis')[0].from;

    const withNote = addNote(placed, deviceId, { text: 'spare uplink', how: 'typed', actor: ACTOR_A, now: NOW + 2 });
    const noteId = withNote.nodes.find((n) => n.id.startsWith('note:'))!.id;
    const noteRemoved = removeNote(withNote, noteId, { actor: ACTOR_A, now: NOW + 3 });
    const removeNoteBatchId = noteRemoved.batches.at(-1)!.id;
    const deviceGone = removeChassis(noteRemoved, chassisId, { actor: ACTOR_A, now: NOW + 4 });

    expect(findNode(deviceGone, deviceId)!.absentSince).toBe(NOW + 4);
    expect(() => undo(deviceGone, removeNoteBatchId, { actor: ACTOR_A, now: NOW + 5 })).toThrow(UndoConflictError);

    // Refused, not partially applied: the note stays gone under its dead owner.
    expect(findNode(deviceGone, noteId)!.absentSince).toBe(NOW + 3);
  });

  it('undoing an add skips elements a later batch already tombstoned', () => {
    const made = createSketchDevice(emptyDocument(), { actor: ACTOR_A, now: NOW });
    const createId = made.batches.at(-1)!.id;
    const chassisId = made.nodes.find((n) => n.id.startsWith('chassis:'))!.id;
    const removed = removeChassis(made, chassisId, { actor: ACTOR_A, now: NOW + 1 });

    const undone = undo(removed, createId, { actor: ACTOR_A, now: NOW + 2 });
    expect(undone.batches.at(-1)!.ops).toEqual([]);
    expect(undone.nodes.every((n) => n.absentSince === NOW + 1)).toBe(true);
  });
});
