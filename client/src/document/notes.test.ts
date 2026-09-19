import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../api/catalogue';
import { createRack, placeChassis, UnknownReferenceError } from './commands';
import { emptyDocument, edgesIn, edgesOut, findNode, formatNodeId, type Document } from './model';
import { addNote, notesOf, removeNote, NotNotableError } from './notes';
import { newUlid } from './ulid';

const NOW = 1_700_000_000_000;
const ACTOR = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const MODEL_1U: CatalogueModel = {
  vendor: 'juniper',
  model: 'EX4300-48P',
  rackUnits: 1,
  reviewedBy: 'reviewer',
  source: { cite: 'cite', readOn: '2026-09-14' },
  psuSlots: [],
  faceplates: [{ face: 'front', portCount: 1, ports: [{ kind: 'RJ45', number: 0, uplink: false, row: 'single', column: 0, groupGapBefore: false }] }],
};

function docWithPlacedChassis(): { doc: Document; deviceId: string; chassisId: string; portId: string; rackId: string } {
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
  const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', now: NOW });
  const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
  const placed = placeChassis(withRack, rackId, MODEL_1U, 1, 'front', { now: NOW });
  const mounted = edgesIn(placed, rackId, 'MountedIn')[0];
  const chassisId = mounted.from;
  const hasChassis = edgesIn(placed, chassisId, 'HasChassis')[0];
  const deviceId = hasChassis.from;
  const portId = edgesOut(placed, chassisId, 'HasPort')[0].to;
  return { doc: placed, deviceId, chassisId, portId, rackId };
}

describe('addNote', () => {
  it('adds a typed note on a Device', () => {
    const { doc, deviceId } = docWithPlacedChassis();
    const next = addNote(doc, deviceId, { text: 'ships cold, check the fan tray', how: 'typed', actor: ACTOR, now: NOW });
    const notes = notesOf(next, deviceId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ text: 'ships cold, check the fan tray', how: 'typed', lineCount: undefined, who: ACTOR, when: NOW });
  });

  it('adds a pasted note on a PhysicalPort, with a line count', () => {
    const { doc, portId } = docWithPlacedChassis();
    const next = addNote(doc, portId, { text: 'uplink to core', how: 'pasted', lineCount: 3, actor: ACTOR, now: NOW });
    const notes = notesOf(next, portId);
    expect(notes[0]).toMatchObject({ how: 'pasted', lineCount: 3 });
  });

  it('adds a note on a Rack', () => {
    const { doc, rackId } = docWithPlacedChassis();
    const next = addNote(doc, rackId, { text: 'breaker panel is behind this rack', how: 'typed', actor: ACTOR, now: NOW });
    expect(notesOf(next, rackId)).toHaveLength(1);
  });

  it('ignores lineCount on a typed note (schema: absent for typed)', () => {
    const { doc, deviceId } = docWithPlacedChassis();
    const next = addNote(doc, deviceId, { text: 'x', how: 'typed', lineCount: 5, actor: ACTOR, now: NOW });
    expect(notesOf(next, deviceId)[0].lineCount).toBeUndefined();
  });

  it('refuses a Chassis (not in Notable)', () => {
    const { doc, chassisId } = docWithPlacedChassis();
    expect(() => addNote(doc, chassisId, { text: 'x', how: 'typed', actor: ACTOR, now: NOW })).toThrow(NotNotableError);
  });

  it('refuses an owner this document has no live node for', () => {
    const { doc } = docWithPlacedChassis();
    expect(() =>
      addNote(doc, 'device:01ARZ3NDEKTSV4RRFFQ69G5FAV', { text: 'x', how: 'typed', actor: ACTOR, now: NOW }),
    ).toThrow(UnknownReferenceError);
  });

  it('writes one Origin::Hand batch with add_node/set_field(s)/add_edge', () => {
    const { doc, deviceId } = docWithPlacedChassis();
    const next = addNote(doc, deviceId, { text: 'hello', how: 'typed', actor: ACTOR, now: NOW });
    const batch = next.batches.at(-1)!;
    expect(batch.label).toBe('add note');
    expect(batch.ops.map((o) => o.type)).toEqual(['add_node', 'set_field', 'set_field', 'add_edge']);
  });
});

describe('removeNote', () => {
  it('tombstones the note and its HasNote edge', () => {
    const { doc, deviceId } = docWithPlacedChassis();
    const withNote = addNote(doc, deviceId, { text: 'x', how: 'typed', actor: ACTOR, now: NOW });
    const noteId = notesOf(withNote, deviceId)[0].id;
    const hasNoteEdge = edgesOut(withNote, deviceId, 'HasNote')[0];

    const removed = removeNote(withNote, noteId, { actor: ACTOR, now: NOW + 1 });
    expect(findNode(removed, noteId)!.absentSince).toBe(NOW + 1);
    expect(removed.edges.find((e) => e.id === hasNoteEdge.id)!.absentSince).toBe(NOW + 1);
    expect(notesOf(removed, deviceId)).toHaveLength(0);
  });

  it('refuses a noteId with no live owning edge', () => {
    const { doc } = docWithPlacedChassis();
    expect(() => removeNote(doc, 'note:01ARZ3NDEKTSV4RRFFQ69G5FAV', { now: NOW })).toThrow(UnknownReferenceError);
  });
});

describe('notesOf', () => {
  it('is empty for an owner with no notes', () => {
    const { doc, deviceId } = docWithPlacedChassis();
    expect(notesOf(doc, deviceId)).toEqual([]);
  });

  it('lists more than one note, in HasNote order', () => {
    const { doc, deviceId } = docWithPlacedChassis();
    const once = addNote(doc, deviceId, { text: 'first', how: 'typed', actor: ACTOR, now: NOW });
    const twice = addNote(once, deviceId, { text: 'second', how: 'typed', actor: ACTOR, now: NOW + 1 });
    const notes = notesOf(twice, deviceId);
    expect(notes.map((n) => n.text)).toEqual(['first', 'second']);
  });
});
