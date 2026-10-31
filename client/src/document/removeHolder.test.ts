import { describe, expect, it } from 'vitest';
import { addCableRun } from './cableRuns';
import { HolderNotEmptyError, createRack, createShelf, createSketchDevice, createSurface, holderContents, movePlacement, removeHolder } from './commands';
import { emptyDocument, findNode, formatNodeId, parseNodeId, type Document } from './model';
import { newUlid } from './ulid';
import { undo } from './undo';

const NOW = 1_700_000_000_000;
const ACTOR = '01HZZZZZZZZZZZZZZZZZZZZZZA';

function premises(): { doc: Document; premisesId: string } {
  const premisesId = formatNodeId('Premises', newUlid(NOW));
  return { doc: { ...emptyDocument(), nodes: [{ id: premisesId, existence: newUlid(NOW), fields: {} }] }, premisesId };
}

function rack(): { doc: Document; rackId: string } {
  const { doc, premisesId } = premises();
  const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 12, unitNumbering: 'ascending', now: NOW });
  return { doc: withRack, rackId: withRack.nodes.find((n) => n.id.startsWith('rack:'))!.id };
}

const live = (doc: Document, id: string) => findNode(doc, id)?.absentSince === undefined;

describe('removeHolder', () => {
  it('removes an empty rack, with its cable runs, as one batch', () => {
    let { doc, rackId } = rack();
    doc = addCableRun(doc, rackId, { form: 'tray', side: 'top', now: NOW });
    const runId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'CableRun')!.id;
    const batches = doc.batches.length;
    const next = removeHolder(doc, rackId, { now: NOW + 1 });
    expect(live(next, rackId)).toBe(false);
    expect(live(next, runId)).toBe(false);
    expect(next.batches).toHaveLength(batches + 1);
  });

  it('refuses a rack with a device or a shelf on it, and names them', () => {
    let { doc, rackId } = rack();
    const before = new Set(doc.nodes.map((n) => n.id));
    doc = createSketchDevice(doc, { hostname: 'sw1', now: NOW });
    const chassisId = doc.nodes.find((n) => !before.has(n.id) && n.id.startsWith('chassis:'))!.id;
    doc = movePlacement(doc, chassisId, { kind: 'rack', rackId, positionU: 1, face: 'front' }, { now: NOW });
    doc = createShelf(doc, rackId, { positionU: 5, label: 'Shelf', now: NOW });
    expect(holderContents(doc, rackId)).toEqual({ devices: 1, shelves: 1, others: 0 });
    expect(() => removeHolder(doc, rackId, { now: NOW })).toThrow(HolderNotEmptyError);
    expect(() => removeHolder(doc, rackId, { now: NOW })).toThrow('Empty it first: 1 device, 1 shelf still on it.');
  });

  it('removes an empty shelf and an empty wall', () => {
    let { doc, rackId } = rack();
    doc = createShelf(doc, rackId, { positionU: 5, label: 'Shelf', now: NOW });
    const shelfId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'PassiveNode')?.id;
    expect(shelfId).toBeDefined();
    const noShelf = removeHolder(doc, shelfId!, { now: NOW + 1 });
    expect(live(noShelf, shelfId!)).toBe(false);
    expect(holderContents(noShelf, rackId)).toEqual({ devices: 0, shelves: 0, others: 0 });

    const p = premises();
    const withWall = createSurface(p.doc, p.premisesId, { label: 'North wall', form: 'wall', now: NOW });
    const wallId = withWall.nodes.find((n) => n.id !== p.premisesId)!.id;
    expect(live(removeHolder(withWall, wallId, { now: NOW + 1 }), wallId)).toBe(false);
  });

  it('comes back with one undo', () => {
    const { doc, rackId } = rack();
    const removed = removeHolder(doc, rackId, { actor: ACTOR, now: NOW + 1 });
    const undone = undo(removed, removed.batches[removed.batches.length - 1]!.id, { actor: ACTOR, now: NOW + 2 });
    expect(live(undone, rackId)).toBe(true);
  });
});
