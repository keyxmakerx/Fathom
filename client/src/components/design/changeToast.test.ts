import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { connectPorts } from '../../document/cables';
import { addSketchPort, createRack, createSketchDevice, placeChassis, removeChassis } from '../../document/commands';
import { setDeviceField } from '../../document/edit';
import { moveFree } from '../../document/freeform';
import { edgesIn, emptyDocument, formatNodeId, type Batch, type Document } from '../../document/model';
import { addNote } from '../../document/notes';
import { newUlid } from '../../document/ulid';
import { redo, undo } from '../../document/undo';
import { createPremises } from '../racks/emptyDesign';
import { ChangeToast, TOAST_MS } from './ChangeToast';
import { freshOwnChange, historyWordsOf, toastWords } from './changeToast';

const ME = 'account:me';
const THEM = 'account:them';

function device(doc: Document, actor: string, now: number): Document {
  return createSketchDevice(doc, { actor, now, hostname: 'sw-01' });
}

describe('toastWords', () => {
  it('says what happened in plain words', () => {
    expect(toastWords('add sketch port')).toBe('Port added');
    expect(toastWords('remove chassis')).toBe('Device removed');
    expect(toastWords('set Device.hostname')).toBe('Name changed');
    expect(toastWords('add 4 ports')).toBe('4 ports added');
    expect(toastWords('add 1 ports')).toBe('Port added');
  });

  it('reads an unknown label as a sentence rather than hiding it', () => {
    expect(toastWords('import switches.csv')).toBe('Import switches.csv');
    expect(toastWords('set Something.new')).toBe('Changed');
  });

  it('says undo and redo, down to the change underneath', () => {
    expect(toastWords('undo of add sketch port')).toBe('Undone: port added');
    expect(toastWords('redo of undo of add sketch port')).toBe('Redone: port added');
  });
});

describe('freshOwnChange', () => {
  const base = device(emptyDocument(), ME, 1_000);

  it('shows nothing on first load', () => {
    expect(freshOwnChange(null, base, ME)).toBeNull();
    expect(freshOwnChange(base, base, ME)).toBeNull();
  });

  it('shows a change this person just made', () => {
    const chassis = base.nodes.find((n) => n.id.startsWith('chassis:'))!.id;
    const next = addSketchPort(base, chassis, { label: 'eth0', connector: 'rj45', face: 'front' }, { actor: ME, now: 2_000 });
    const fresh = freshOwnChange(base, next, ME);
    expect(fresh).toMatchObject({ words: 'Port added to sw-01', kind: 'change' });
    expect(fresh?.batchId).toBe(next.batches[next.batches.length - 1]!.id);
  });

  it("never shows a teammate's live edit", () => {
    const chassis = base.nodes.find((n) => n.id.startsWith('chassis:'))!.id;
    const next = addSketchPort(base, chassis, { label: 'eth0', connector: 'rj45', face: 'front' }, { actor: THEM, now: 2_000 });
    expect(freshOwnChange(base, next, ME)).toBeNull();
  });

  it('shows nothing when a different design replaced this one', () => {
    const other = device(emptyDocument(), ME, 5_000);
    expect(freshOwnChange(base, other, ME)).toBeNull();
  });

  it('says Undone for this person\'s own undo', () => {
    const chassis = base.nodes.find((n) => n.id.startsWith('chassis:'))!.id;
    const next = addSketchPort(base, chassis, { label: 'eth0', connector: 'rj45', face: 'front' }, { actor: ME, now: 2_000 });
    const target = next.batches[next.batches.length - 1]!;
    const undone = undo(next, target.id, { actor: ME, now: 3_000 });
    expect(freshOwnChange(next, undone, ME)).toMatchObject({ words: 'Undone: port added', kind: 'undo' });
  });

  it('shows nothing for someone signed out', () => {
    expect(freshOwnChange(emptyDocument(), base, null)).toBeNull();
  });
});

describe('naming the thing', () => {
  const MODEL = {
    vendor: 'juniper',
    model: 'EX4300-48P',
    rackUnits: 1,
    reviewedBy: 'reviewer',
    source: { cite: 'cite', readOn: '2026-09-14' },
    psuSlots: [],
    faceplates: [{ face: 'front' as const, portCount: 1, ports: [{ kind: 'RJ45', number: 0, uplink: false, row: 'single' as const, column: 0, groupGapBefore: false }] }],
  };
  const premisesId = formatNodeId('Premises', newUlid(1_000));
  const empty: Document = { ...emptyDocument(), nodes: [{ id: premisesId, existence: newUlid(1_000), fields: {} }] };
  const withRack = createRack(empty, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', actor: ME, now: 1_001 });
  const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;

  it('says which device went into which rack, and which came out', () => {
    const placed = placeChassis(withRack, rackId, MODEL, 4, 'front', { actor: ME, now: 2_000 });
    expect(freshOwnChange(withRack, placed, ME)?.words).toBe('Added EX4300-48P to R1');
    const chassisId = edgesIn(placed, rackId, 'MountedIn')[0]!.from;
    const removed = removeChassis(placed, chassisId, { actor: ME, now: 3_000 });
    expect(freshOwnChange(placed, removed, ME)?.words).toBe('Removed EX4300-48P from R1');
  });

  it('keeps the plain words for a change that names nothing', () => {
    expect(freshOwnChange(withRack, device(withRack, ME, 2_000), ME)?.words).toBe('Added sw-01');
  });
});

describe('historyWordsOf', () => {
  const base = device(emptyDocument(), ME, 1_000);
  const deviceIds = (doc: Document) => doc.nodes.filter((n) => n.id.startsWith('device:')).map((n) => n.id);
  const last = (doc: Document) => doc.batches[doc.batches.length - 1]!;
  const addressed = setDeviceField(base, deviceIds(base)[0]!, 'management_address', '10.0.0.2', { actor: ME, now: 2_000 });
  /** A change written by hand that sets one field on each of `ids`. */
  const touching = (doc: Document, ids: string[]): { doc: Document; batch: Batch } => {
    const batch: Batch = { id: newUlid(9_000), label: 'set fields', ops: ids.map((element) => ({ type: 'set_field', element, key: 'Device.role', presence: 'set', prov: newUlid(9_000) })) };
    return { doc: { ...doc, batches: [...doc.batches, batch] }, batch };
  };

  it('says what a change was made to', () => {
    expect(last(addressed).label).toBe('set Device.management_address');
    expect(historyWordsOf(addressed)(last(addressed))).toBe('Address changed · sw-01');
  });

  it('says an undo or a redo as what it took back or brought back, however many stand between', () => {
    const undone = undo(addressed, last(addressed).id, { actor: ME, now: 3_000 });
    const redone = redo(undone, last(undone).id, { actor: ME, now: 4_000 });
    const wordsOf = historyWordsOf(redone);
    expect(last(redone).label).toBe('redo of undo of set Device.management_address');
    expect(wordsOf(last(redone))).toBe('Redone: address changed · sw-01');
    expect(wordsOf(last(undone))).toBe('Undone: address changed · sw-01');
  });

  it('leaves alone words that already name their device', () => {
    expect(historyWordsOf(base)(last(base))).toBe('Added sw-01');
    const undone = undo(base, last(base).id, { actor: ME, now: 3_000 });
    expect(historyWordsOf(undone)(last(undone))).toBe('Undone: added sw-01');
  });

  it('names two things, and none when a change touches more', () => {
    const second = createSketchDevice(base, { actor: ME, now: 1_500, hostname: 'sw-02' });
    const third = createSketchDevice(second, { actor: ME, now: 1_600, hostname: 'sw-03' });
    const two = touching(third, deviceIds(third).slice(0, 2));
    expect(historyWordsOf(two.doc)(two.batch)).toBe('Fields changed · sw-01 and sw-02');
    const three = touching(third, deviceIds(third));
    expect(historyWordsOf(three.doc)(three.batch)).toBe('Fields changed');
  });

  // A drag writes the thing's place on the canvas, its pin. The first drag makes the pin and every later one
  // writes it, and that later one once read "Moved" with nothing after it.
  it('says a move by the thing moved, at the first drag and at every one after', () => {
    const chassisId = base.nodes.find((n) => n.id.startsWith('chassis:'))!.id;
    const once = moveFree(base, [{ id: chassisId, x: 40, y: 80 }], { actor: ME, now: 2_000 });
    const twice = moveFree(once, [{ id: chassisId, x: 120, y: 160 }], { actor: ME, now: 3_000 });
    expect(historyWordsOf(once)(last(once))).toBe('Moved · sw-01');
    expect(last(twice).ops.every((op) => op.type === 'set_field')).toBe(true);
    expect(historyWordsOf(twice)(last(twice))).toBe('Moved · sw-01');
    const undone = undo(twice, last(twice).id, { actor: ME, now: 4_000 });
    expect(historyWordsOf(undone)(last(undone))).toBe('Undone: moved · sw-01');
  });

  it('says a new thing by its own name, and one that joins others by what it joins', () => {
    const started = createPremises(emptyDocument(), { actor: ME, now: 1_000 });
    let doc = createRack(started.doc, started.premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', actor: ME, now: 1_001 });
    doc = createSketchDevice(doc, { actor: ME, now: 1_002, hostname: 'core-01' });
    doc = createSketchDevice(doc, { actor: ME, now: 1_003, hostname: 'acc-01' });
    // Each port at its own moment: two ids minted in one millisecond sort either way round.
    let at = 1_004;
    for (const chassis of doc.nodes.filter((n) => n.id.startsWith('chassis:'))) {
      doc = addSketchPort(doc, chassis.id, { label: 'eth0', connector: 'rj45', face: 'front' }, { actor: ME, now: at });
      at += 1;
    }
    const ports = doc.nodes.filter((n) => n.id.startsWith('physical-port:')).map((n) => n.id);
    doc = connectPorts(doc, ports[0]!, ports[1]!, { sheath: 'blue' }, { actor: ME, now: 1_010 });
    doc = addNote(doc, ports[0]!, { text: 'checked the cabling', how: 'typed', actor: ME, now: 1_011 });
    expect(doc.batches.map(historyWordsOf(doc))).toEqual([
      // The design's one place, made with the first thing drawn and named by nobody.
      'Design started',
      // Not "R1 and Premises": the place a rack stands in is not what was added.
      'Rack added · R1',
      'Added core-01',
      'Added acc-01',
      'Port added to core-01',
      'Port added to acc-01',
      'Cable connected · core-01 and acc-01',
      'Note added · core-01',
    ]);
  });

  it('says a thing with no name once, by what it is', () => {
    const unnamed = createSketchDevice(emptyDocument(), { actor: ME, now: 1_000 });
    const one = touching(unnamed, deviceIds(unnamed));
    expect(historyWordsOf(one.doc)(one.batch)).toBe('Fields changed · an unnamed device');
  });

  it('calls a device whose adding was undone what it was called, in every row about it', () => {
    const undone = undo(addressed, last(addressed).id, { actor: ME, now: 3_000 });
    const gone = undo(undone, base.batches[0]!.id, { actor: ME, now: 4_000 });
    const wordsOf = historyWordsOf(gone);
    expect(gone.batches.map(wordsOf)).toEqual(['Added sw-01', 'Address changed · sw-01', 'Undone: address changed · sw-01', 'Undone: added sw-01']);
  });

  it('keeps to the words for the label when the change behind an undo is no longer held', () => {
    const orphan: Batch = { id: newUlid(6_000), label: 'undo of set Device.hostname', ops: [], reverses: newUlid(1) };
    expect(historyWordsOf({ ...base, batches: [...base.batches, orphan] })(orphan)).toBe('Undone: name changed');
  });
});

describe('ChangeToast timing', () => {
  it('stays eight seconds', () => {
    expect(TOAST_MS).toBe(8_000);
  });
});

describe('ChangeToast markup', () => {
  it('is a polite status region, empty until there is something to say', () => {
    const markup = renderToStaticMarkup(
      createElement(ChangeToast, { doc: base(), accountId: ME, undoBatchId: null, redoBatchId: null, onUndo: () => {}, onRedo: () => {} }),
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).not.toContain('<button');
  });
});

function base(): Document {
  return device(emptyDocument(), ME, 1_000);
}
