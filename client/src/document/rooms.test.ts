import { describe, expect, it } from 'vitest';

import { emptyDocument } from './model';
import { readPlain, writePlain } from './plain';
import {
  addRoom,
  areaM2,
  floorPlansOf,
  removeRoom,
  renameRoom,
  roomsOf,
  scaleFromPoints,
  setFloorPlanImage,
  setFloorPlanScale,
} from './rooms';

const OPTS = { actor: 'acct-test', now: 1_790_000_000_000 };
const IMAGE = { name: 'ground.png', fileId: '0123456789abcdef0123456789abcdef', sha256: 'ab'.repeat(32), widthPx: 2000, heightPx: 1000 };
const roundTrip = (doc: ReturnType<typeof emptyDocument>) => readPlain(writePlain(doc));

describe('the room builder graph (ADR-0051, schema 0.29)', () => {
  it('adds a room with its corners in order, in a design that had no premises yet, and it survives a save', () => {
    const { doc } = addRoom(emptyDocument(), { label: ' 214 ', floor: '2', corners: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }] }, OPTS);
    const [room] = roomsOf(roundTrip(doc));
    expect(room).toMatchObject({ label: '214', floor: '2' });
    expect(room!.corners).toEqual([{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }]);
    expect(areaM2(room!.corners)).toBe(12);
  });

  it('refuses a room with no name or no floor inside it', () => {
    expect(() => addRoom(emptyDocument(), { label: '', corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }, OPTS)).toThrow(/name/);
    expect(() => addRoom(emptyDocument(), { label: 'A', corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }] }, OPTS)).toThrow(/three corners/);
  });

  it('renames and removes a room, its corners going with it', () => {
    const made = addRoom(emptyDocument(), { label: 'A', corners: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }, OPTS);
    const renamed = renameRoom(made.doc, made.roomId, 'IDF-2', OPTS);
    expect(roomsOf(renamed).map((r) => r.label)).toEqual(['IDF-2']);
    const gone = roundTrip(removeRoom(renamed, made.roomId, OPTS));
    expect(roomsOf(gone)).toEqual([]);
    expect(gone.nodes.filter((n) => n.id.startsWith('RoomCorner') && n.absentSince === undefined)).toEqual([]);
  });

  it('puts a picture behind a floor, scales it, and a new picture clears the old scale', () => {
    let doc = setFloorPlanImage(emptyDocument(), 'Ground', IMAGE, OPTS);
    const [plan] = floorPlansOf(doc);
    expect(plan).toMatchObject({ floor: 'Ground', fileId: IMAGE.fileId, widthPx: 2000, umPerPx: null });
    doc = setFloorPlanScale(doc, plan!.id, scaleFromPoints({ x: 100, y: 100 }, { x: 1100, y: 100 }, 10_000), OPTS);
    expect(floorPlansOf(roundTrip(doc))[0]!.umPerPx).toBe(10_000);
    doc = setFloorPlanImage(doc, 'Ground', { ...IMAGE, name: 'ground-v2.png' }, OPTS);
    const after = floorPlansOf(roundTrip(doc));
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ name: 'ground-v2.png', umPerPx: null });
  });

  it('works out a scale from two points, and refuses two points on top of each other', () => {
    expect(scaleFromPoints({ x: 0, y: 0 }, { x: 300, y: 400 }, 5000)).toBe(10_000);
    expect(() => scaleFromPoints({ x: 5, y: 5 }, { x: 5, y: 5 }, 1000)).toThrow(/two different points/);
  });
});
