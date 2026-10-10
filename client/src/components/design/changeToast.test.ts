import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { addSketchPort, createRack, createSketchDevice, placeChassis, removeChassis } from '../../document/commands';
import { edgesIn, emptyDocument, formatNodeId, type Document } from '../../document/model';
import { newUlid } from '../../document/ulid';
import { undo } from '../../document/undo';
import { ChangeToast, TOAST_MS } from './ChangeToast';
import { freshOwnChange, toastWords } from './changeToast';

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
