// A refused Undo or Redo says, in one sentence, what stood in the way and whose change it was. It names the person
// as every history does and the thing by its own name: never an id.
import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../../api/catalogue';
import { createRack, placeChassis, removeChassis } from '../../document/commands';
import { setDeviceField } from '../../document/edit';
import { edgesIn, emptyDocument, formatNodeId, type Document } from '../../document/model';
import { addNote, removeNote } from '../../document/notes';
import { newUlid } from '../../document/ulid';
import { UndoConflictError, conflict, undo, type UndoConflict } from '../../document/undo';
import { EDITS_OFF } from '../shell/hintWords';
import { notOffered, refusedSentence } from './undoWords';

const T = 1_700_000_000_000;
const ME = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const THEM = '01ARZ3NDEKTSV4RRFFQ69G5FBV';
const bob = (): string => 'Bob Roe';

const MODEL: CatalogueModel = {
  vendor: 'juniper',
  model: 'EX4300-48P',
  rackUnits: 1,
  reviewedBy: 'reviewer',
  source: { cite: 'cite', readOn: '2026-09-14' },
  psuSlots: [],
  faceplates: [{ face: 'front', portCount: 1, ports: [{ kind: 'RJ45', number: 0, uplink: false, row: 'single', column: 0, groupGapBefore: false }] }],
};

function rackDoc(): { doc: Document; rackId: string } {
  const premisesId = formatNodeId('Premises', newUlid(T));
  const start: Document = {
    ...emptyDocument(),
    nodes: [{ id: premisesId, existence: newUlid(T), fields: { 'Premises.label': { presence: 'set', prov: newUlid(T), value: 'Riverside CO' } } }],
  };
  const doc = createRack(start, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', actor: ME, now: T });
  return { doc, rackId: doc.nodes.find((n) => n.id !== premisesId)!.id };
}

/** The refusal `undo` throws for this batch. */
function refusalOf(doc: Document, batchId: string): UndoConflict {
  try {
    undo(doc, batchId, { actor: ME, now: T + 100 });
  } catch (error) {
    if (error instanceof UndoConflictError) return error.conflict;
    throw error;
  }
  throw new Error('the undo was not refused');
}

describe('what a refused undo says', () => {
  it('names the rack someone else has put a device in since, and says what they did', () => {
    const { doc, rackId } = rackDoc();
    const mine = placeChassis(doc, rackId, MODEL, 10, 'front', { actor: ME, now: T + 1 });
    const mineId = mine.batches.at(-1)!.id;
    const theirs = placeChassis(mine, rackId, MODEL, 20, 'front', { actor: THEM, now: T + 2 });

    const c = conflict(theirs, mineId, ME, { skipChangedFields: true })!;
    expect(refusedSentence(theirs, c, 'undo', bob)).toBe('Nothing was undone: R1 was changed by Bob Roe since (added EX4300-48P to R1).');
    expect(refusedSentence(theirs, c, 'redo', bob)).toBe('Nothing was redone: R1 was changed by Bob Roe since (added EX4300-48P to R1).');
  });

  it('names the device by the name it has now, and calls one without a name that', () => {
    const { doc, rackId } = rackDoc();
    const placed = placeChassis(doc, rackId, MODEL, 10, 'front', { actor: ME, now: T + 1 });
    const chassisId = edgesIn(placed, rackId, 'MountedIn')[0].from;
    const deviceId = edgesIn(placed, chassisId, 'HasChassis')[0].from;
    const mine = setDeviceField(placed, deviceId, 'management_address', '10.0.0.2', { actor: ME, now: T + 2 });
    const mineId = mine.batches.at(-1)!.id;
    const theirs = setDeviceField(mine, deviceId, 'management_address', '10.0.0.99', { actor: THEM, now: T + 3 });
    expect(refusedSentence(theirs, refusalOf(theirs, mineId), 'undo', bob)).toBe('Nothing was undone: an unnamed device was changed by Bob Roe since (address changed).');

    const named = setDeviceField(theirs, deviceId, 'hostname', 'core-sw-01', { actor: THEM, now: T + 4 });
    expect(refusedSentence(named, refusalOf(named, mineId), 'undo', bob)).toBe('Nothing was undone: core-sw-01 was changed by Bob Roe since (address changed).');
  });

  it('never quotes an id: a person nobody has heard of is a colleague, a thing with no name is part of the design', () => {
    const { doc } = rackDoc();
    const c: UndoConflict = { kind: 'later-change', batchId: 'not in this design', label: 'x', actor: THEM, at: T, element: 'cable:01ARZ3NDEKTSV4RRFFQ69G5FCV' };
    const said = refusedSentence(doc, c, 'undo', () => 'a colleague');
    expect(said).toBe('Nothing was undone: the same part of the design was changed by a colleague since.');
    expect(said).not.toContain(THEM);
  });

  it('says where a removed device can no longer go back to', () => {
    const { doc, rackId } = rackDoc();
    const first = placeChassis(doc, rackId, MODEL, 12, 'front', { actor: ME, now: T + 1 });
    const chassisId = edgesIn(first, rackId, 'MountedIn')[0].from;
    const removed = removeChassis(first, chassisId, { actor: ME, now: T + 2 });
    const removeId = removed.batches.at(-1)!.id;
    const retaken = placeChassis(removed, rackId, MODEL, 12, 'front', { actor: ME, now: T + 3 });

    const said = refusedSentence(retaken, refusalOf(retaken, removeId), 'undo', bob);
    expect(said).toBe('Nothing was undone: U12 in R1 is taken now, by an unnamed device.');
    expect(said).not.toMatch(/rack:|chassis:/);
  });

  it('says so when what a removed thing was on is gone', () => {
    const { doc, rackId } = rackDoc();
    const placed = placeChassis(doc, rackId, MODEL, 1, 'front', { actor: ME, now: T + 1 });
    const chassisId = edgesIn(placed, rackId, 'MountedIn')[0].from;
    const deviceId = edgesIn(placed, chassisId, 'HasChassis')[0].from;
    const withNote = addNote(placed, deviceId, { text: 'spare uplink', how: 'typed', actor: ME, now: T + 2 });
    const noteId = withNote.nodes.find((n) => n.id.startsWith('note:'))!.id;
    const noteGone = removeNote(withNote, noteId, { actor: ME, now: T + 3 });
    const removeNoteId = noteGone.batches.at(-1)!.id;
    const deviceGone = removeChassis(noteGone, chassisId, { actor: ME, now: T + 4 });

    expect(refusedSentence(deviceGone, refusalOf(deviceGone, removeNoteId), 'undo', bob)).toBe('Nothing was undone: what it was attached to is gone now.');
  });

  it('says a recorded plan stays as written', () => {
    const { doc } = rackDoc();
    expect(refusedSentence(doc, { kind: 'recorded-plan', element: 'maintenance-plan:x' }, 'undo', bob)).toBe('Nothing was undone: a recorded plan is history as written.');
  });
});

describe('why Undo or Redo is greyed', () => {
  const free = { canDraw: true, phoneCanvas: false, lookingBack: false, any: true };

  it('is offered when this person may change the design and has a step to take', () => {
    expect(notOffered('undo', free)).toBeNull();
    expect(notOffered('redo', free)).toBeNull();
  });

  it('with no step to take, says there is nothing to undo or to redo', () => {
    expect(notOffered('undo', { ...free, any: false })).toBe('nothingToUndo');
    expect(notOffered('redo', { ...free, any: false })).toBe('nothingToRedo');
  });

  it('while a save is on show, says so, whether or not there is a step to take', () => {
    expect(notOffered('undo', { ...free, lookingBack: true })).toBe('save');
    expect(notOffered('redo', { ...free, lookingBack: true, any: false })).toBe('save');
  });

  it('with the list of saves open and none chosen, nothing is in the way', () => {
    // The drawing is the design as it is now and can be changed, so a change can be taken back.
    expect(notOffered('undo', { ...free, lookingBack: false })).toBeNull();
  });

  it('tells a person who may only look that first, and the phone drawing before a save', () => {
    expect(notOffered('undo', { canDraw: false, phoneCanvas: true, lookingBack: true, any: false })).toBe('viewOnly');
    expect(notOffered('undo', { ...free, phoneCanvas: true, lookingBack: true })).toBe('phoneCanvas');
  });

  it('has a sentence for the card and a short line for a menu, for every reason', () => {
    for (const [why, said] of Object.entries(EDITS_OFF)) {
      expect(said.hint, why).toMatch(/^[A-Z].*\.$/);
      expect(said.hint.length, why).toBeLessThanOrEqual(120);
      // A menu's reason is a line, not a sentence: "Select a device first".
      expect(said.short, why).toMatch(/^[A-Z].*[^.]$/);
      expect(said.short.length, why).toBeLessThanOrEqual(40);
    }
  });
});
