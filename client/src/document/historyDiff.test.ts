import { describe, expect, it } from 'vitest';

import { createRack, createSketchDevice, removeChassis } from './commands';
import { setDeviceField } from './edit';
import { describeRestore, describeSave, outlineIds, outlineSelectors } from './historyDiff';
import { emptyDocument, formatNodeId, type Document } from './model';
import { newUlid } from './ulid';

const NOW = 1_700_000_000_000;
const ACTOR = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function base(): { doc: Document; premisesId: string } {
  const premisesId = formatNodeId('Premises', newUlid(NOW));
  const doc: Document = {
    ...emptyDocument(),
    nodes: [
      { id: premisesId, existence: newUlid(NOW), fields: { 'Premises.label': { presence: 'set', prov: newUlid(NOW), value: 'HQ' } } },
    ],
  };
  return { doc, premisesId };
}

describe('describeSave', () => {
  it('names the first save', () => {
    expect(describeSave(null, emptyDocument()).summary).toBe('Design created');
  });

  it('reads what a save added off the new batches and outlines it', () => {
    const { doc, premisesId } = base();
    const next = createRack(doc, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', actor: ACTOR, now: NOW });
    const rackId = next.nodes.find((n) => n.id !== premisesId)!.id;
    const change = describeSave(doc, next);
    expect(change.summary).toBe('added 1 rack');
    expect(change.changed).toContain(rackId);
  });

  it('says a save with no new batch changed nothing drawn', () => {
    const { doc } = base();
    expect(describeSave(doc, doc)).toEqual({ summary: 'Saved with no drawn change', changed: [] });
  });

  it('names devices and renames, and falls back to batch labels when nothing drawn differs', () => {
    const { doc, premisesId } = base();
    let next = doc;
    for (const label of ['R1', 'R2', 'R3', 'R4']) {
      next = createRack(next, premisesId, { label, heightU: 42, unitNumbering: 'ascending', actor: ACTOR, now: NOW });
    }
    expect(describeSave(doc, next).summary).toBe('added 4 racks');
  });
});

describe('describeSave summaries', () => {
  it('reads like the mockup', () => {
    const { doc } = base();
    const withNas = createSketchDevice(doc, { hostname: 'nas-01', actor: ACTOR, now: NOW });
    expect(describeSave(doc, withNas).summary).toBe('added nas-01');
    const deviceId = withNas.nodes.find((n) => n.id.startsWith('device:'))!.id;
    const renamed = setDeviceField(withNas, deviceId, 'hostname', 'nas-02', { actor: ACTOR, now: NOW });
    expect(describeSave(withNas, renamed).summary).toBe('renamed nas-01 \u2192 nas-02');
    expect(describeSave(null, withNas).summary).toBe('added nas-01');
  });

  it('names a restore as one', () => {
    const { doc } = base();
    const next: Document = { ...doc, batches: [{ id: newUlid(NOW), label: 'Restored the save from Today 11:45', ops: [] }] };
    expect(describeSave(doc, next).summary).toBe('Restored the save from Today 11:45');
  });

  it('falls back to the batch labels', () => {
    const { doc } = base();
    const next: Document = { ...doc, batches: [{ id: newUlid(NOW), label: 'tidy up', ops: [] }] };
    expect(describeSave(doc, next).summary).toBe('tidy up');
  });

  it('says those changes in the words it is given, when it is given any', () => {
    const { doc } = base();
    const next: Document = { ...doc, batches: [{ id: newUlid(NOW), label: 'set Device.management_address', ops: [] }] };
    expect(describeSave(doc, next, (batch) => `${batch.label}, in words`).summary).toBe('set Device.management_address, in words');
  });

  it('names the one thing a save edited', () => {
    const { doc } = base();
    const withNas = createSketchDevice(doc, { hostname: 'nas-01', actor: ACTOR, now: NOW });
    const deviceId = withNas.nodes.find((n) => n.id.startsWith('device:'))!.id;
    const addressed = setDeviceField(withNas, deviceId, 'management_address', '10.0.0.5', { actor: ACTOR, now: NOW });
    expect(describeSave(withNas, addressed).summary).toBe('edited nas-01');
  });

  it('counts what it edited when that is more than one thing, a cable, or has no name', () => {
    const { doc } = base();
    const field = (value: string) => ({ presence: 'set' as const, prov: newUlid(NOW), value });
    const cableId = formatNodeId('Cable', newUlid(NOW));
    const noteId = formatNodeId('Note', newUlid(NOW));
    const withBoth: Document = { ...doc, nodes: [...doc.nodes, { id: cableId, existence: newUlid(NOW), fields: { 'Cable.label': field('a') } }, { id: noteId, existence: newUlid(NOW), fields: { 'Note.text': field('a') } }] };
    const edit = (d: Document, id: string, key: string): Document => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, fields: { [key]: field('b') } } : n)) });
    expect(describeSave(withBoth, edit(withBoth, cableId, 'Cable.label')).summary).toBe('edited 1 cable');
    expect(describeSave(withBoth, edit(withBoth, noteId, 'Note.text')).summary).toBe('edited 1 item');
    expect(describeSave(withBoth, edit(edit(withBoth, cableId, 'Cable.label'), noteId, 'Note.text')).summary).toBe('edited 2 items');
  });
});

describe('describeRestore', () => {
  it('names what comes back and what goes', () => {
    const { doc, premisesId } = base();
    const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', actor: ACTOR, now: NOW });
    expect(describeRestore(withRack, doc)).toBe('Compared with now: removed 1 rack.');
    expect(describeRestore(doc, withRack)).toBe('Compared with now: added 1 rack.');
    expect(describeRestore(doc, doc)).toBe('Nothing drawn differs from now.');
  });
});

describe('outline', () => {
  it('quotes ids into selectors for nodes and cables', () => {
    expect(outlineSelectors(['x:1'])).toContain('[data-id="chassis:x:1"]');
    expect(outlineSelectors(['x:1'])).toContain('[data-testid="rf__edge-x:1"]');
  });

  it('keeps ids it is given', () => {
    const { doc } = base();
    void removeChassis;
    expect(outlineIds(doc, ['a'])).toEqual(['a']);
  });
});
