import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { addSketchPort, createSketchDevice } from '../../document/commands';
import { emptyDocument, type Document } from '../../document/model';
import { undo } from '../../document/undo';
import { ChangeToast } from './ChangeToast';
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
    expect(fresh).toMatchObject({ words: 'Port added', kind: 'change' });
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
