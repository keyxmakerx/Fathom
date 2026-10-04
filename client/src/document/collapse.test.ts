import { describe, expect, it } from 'vitest';

import { CollapseError, collapseBatches } from './collapse';
import { createRack, createSketchDevice } from './commands';
import { setChassisField, setDeviceField } from './edit';
import { setFieldValues, type FieldDefView } from './fields';
import { emptyDocument, formatNodeId, type Document } from './model';
import { addNote } from './notes';
import { tagObject } from './tags';
import { newUlid } from './ulid';
import { redo, undo, undoable } from './undo';

const NOW = 1_700_000_000_000;
const ME = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER = '01ARZ3NDEKTSV4RRFFQ69G5FBV';
const DEF: FieldDefView = { id: '01ARZ3NDEKTSV4RRFFQ69G5F01', appliesTo: 'device', name: 'Owner', type: 'text', choices: [], version: 1, createdBy: ME, archived: false };

function start(): Document {
  const premises = formatNodeId('Premises', newUlid(NOW));
  const doc: Document = { ...emptyDocument(), nodes: [{ id: premises, existence: newUlid(NOW), fields: { 'Premises.label': { presence: 'set', prov: newUlid(NOW), value: 'HQ' } } }] };
  return createSketchDevice(doc, { hostname: 'old-sw', actor: ME, now: NOW });
}

/** What an import does: new devices with fields, tags and notes, and a change to an existing one. */
function importLike(doc: Document, actor = ME): Document {
  const opts = { actor, now: NOW + 10 };
  const oldDevice = doc.nodes.find((n) => n.id.startsWith('device:'))!.id;
  let d = doc;
  for (const name of ['a-1', 'b-2']) {
    const before = new Set(d.nodes.map((n) => n.id));
    d = createSketchDevice(d, { hostname: name, ...opts });
    const fresh = d.nodes.filter((n) => !before.has(n.id)).map((n) => n.id);
    const dev = fresh.find((i) => i.startsWith('device:'))!;
    const chassis = fresh.find((i) => i.startsWith('chassis:'))!;
    d = setDeviceField(d, dev, 'role', 'switch', opts);
    d = setChassisField(d, chassis, 'serial', `S-${name}`, opts);
    d = tagObject(d, dev, 'imported', opts);
    d = addNote(d, dev, { text: 'from the file', how: 'pasted', lineCount: 1, ...opts });
    d = setFieldValues(d, [{ ownerId: dev, defId: DEF.id, raw: 'Facilities' }], [DEF], opts);
  }
  d = setDeviceField(d, oldDevice, 'role', 'router', opts);
  d = setDeviceField(d, oldDevice, 'role', 'firewall', opts); // the same field written twice
  return setFieldValues(d, [{ ownerId: oldDevice, defId: DEF.id, raw: 'Lab' }], [DEF], opts);
}

const live = (d: Document) => ({ nodes: d.nodes.filter((n) => n.absentSince === undefined).map((n) => n.id).sort(), edges: d.edges.filter((e) => e.absentSince === undefined).map((e) => e.id).sort() });
const values = (d: Document) =>
  d.nodes.filter((n) => n.absentSince === undefined).map((n) => [n.id, Object.entries(n.fields).map(([k, e]) => `${k}=${e.presence}:${String(e.value)}`).sort()] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1));

describe('collapseBatches', () => {
  it('turns many batches into one, keeping every op in order', () => {
    const before = start();
    const after = importLike(before);
    const merged = collapseBatches(before, after, 'import devices.csv');
    const added = after.batches.slice(before.batches.length);
    expect(added.length).toBeGreaterThan(10);
    expect(merged.batches).toHaveLength(before.batches.length + 1);
    expect(merged.batches.slice(0, before.batches.length)).toEqual(before.batches);
    const one = merged.batches.at(-1)!;
    expect(one.label).toBe('import devices.csv');
    expect(one.ops).toEqual(added.flatMap((b) => b.ops));
    expect(merged.nodes).toEqual(after.nodes);
    expect(merged.provenance).toEqual(after.provenance);
  });

  it('one undo removes everything the import added and restores what it changed; redo puts it back', () => {
    const before = start();
    const after = importLike(before);
    const merged = collapseBatches(before, after, 'import devices.csv');
    expect(live(merged).nodes.length).toBeGreaterThan(live(before).nodes.length + 8);

    const mine = undoable(merged, ME);
    expect(mine[0]!.label).toBe('import devices.csv');
    const undone = undo(merged, mine[0]!.id, { actor: ME, now: NOW + 100 });
    expect(live(undone)).toEqual(live(before));
    // The existing device is back to what it was: no role, no Owner value.
    const oldId = before.nodes.find((n) => n.id.startsWith('device:'))!.id;
    const oldNode = undone.nodes.find((n) => n.id === oldId)!;
    expect(oldNode.fields['Device.role']).toBeUndefined();
    expect(values(undone).find(([id]) => id === oldId)).toEqual(values(before).find(([id]) => id === oldId));

    const undoBatch = undone.batches.at(-1)!;
    const redone = redo(undone, undoBatch.id, { actor: ME, now: NOW + 200 });
    expect(live(redone)).toEqual(live(merged));
    expect(values(redone)).toEqual(values(merged));
    expect(redone.nodes.find((n) => n.id === oldId)!.fields['Device.role']).toMatchObject({ presence: 'set', value: 'firewall' });
  });

  it('without collapsing, one undo only reverses the last small step (why this exists)', () => {
    const before = start();
    const after = importLike(before);
    const undone = undo(after, undoable(after, ME)[0]!.id, { actor: ME, now: NOW + 100 });
    expect(live(undone).nodes.length).toBeGreaterThan(live(before).nodes.length);
  });

  it('a single appended batch is relabelled; none returns the document as is', () => {
    const before = start();
    const one = setDeviceField(before, before.nodes.find((n) => n.id.startsWith('device:'))!.id, 'role', 'switch', { actor: ME, now: NOW + 1 });
    expect(collapseBatches(before, one, 'import x').batches.at(-1)!.label).toBe('import x');
    expect(collapseBatches(before, before, 'x')).toBe(before);
  });

  it('cuts a long label to the engine limit on a character boundary', () => {
    const before = start();
    const after = importLike(before);
    const label = collapseBatches(before, after, `import ${'é'.repeat(80)}.csv`).batches.at(-1)!.label;
    expect(new TextEncoder().encode(label).length).toBeLessThanOrEqual(60);
    expect(label.startsWith('import é')).toBe(true);
  });

  it('refuses batches by different accounts, undo batches, and a document that does not continue', () => {
    const before = start();
    const mixed = setDeviceField(importLike(before), before.nodes.find((n) => n.id.startsWith('device:'))!.id, 'role', 'switch', { actor: OTHER, now: NOW + 50 });
    expect(() => collapseBatches(before, mixed, 'x')).toThrow(CollapseError);
    const after = importLike(before);
    const undone = undo(after, undoable(after, ME)[0]!.id, { actor: ME, now: NOW + 100 });
    expect(() => collapseBatches(after, undone, 'x')).toThrow(/undo or redo/);
    expect(() => collapseBatches(after, before, 'x')).toThrow(/does not continue/);
    expect(() => collapseBatches(createRackDoc(), after, 'x')).toThrow(/does not continue/);
  });
});

function createRackDoc(): Document {
  const premises = formatNodeId('Premises', newUlid(NOW));
  const doc: Document = { ...emptyDocument(), nodes: [{ id: premises, existence: newUlid(NOW), fields: {} }] };
  return createRack(doc, premises, { label: 'R9', heightU: 42, unitNumbering: 'ascending', actor: ME, now: NOW });
}
