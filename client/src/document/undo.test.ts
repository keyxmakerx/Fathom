import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../api/catalogue';
import { createRack, placeChassis, removeChassis, UnknownReferenceError } from './commands';
import { connectToOutside, setCableField } from './cables';
import { setRackField } from './edit';
import { LOCAL_ACTOR, edgesIn, edgesOut, emptyDocument, findEdge, findNode, formatNodeId, type Document } from './model';
import { addNote, removeNote } from './notes';
import { setSupplyField } from './supplies';
import { newUlid } from './ulid';
import { UndoConflictError, batchActor, conflict, redo, undo, undoable } from './undo';

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

  it('excludes a batch that has already been reversed', () => {
    const { doc } = docWithRack(ACTOR_A, NOW);
    const createBatchId = doc.batches[0].id;
    const undone = undo(doc, createBatchId, { actor: ACTOR_A, now: NOW + 1 });
    // The create batch is reversed; the undo batch itself (also by A) is not.
    const list = undoable(undone, ACTOR_A);
    expect(list.map((b) => b.id)).toEqual([undone.batches[1].id]);
  });

  it('never lists a LOCAL-stamped batch (nobody signed in wrote it)', () => {
    const { doc } = docWithRack(LOCAL_ACTOR, NOW);
    expect(undoable(doc, ACTOR_A)).toEqual([]);
    expect(undoable(doc, LOCAL_ACTOR)).toEqual([]);
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
    expect(result).toEqual({ kind: 'later-change', batchId: byBBatch.id, label: byBBatch.label, actor: ACTOR_B, at: NOW + 1 });

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
});
