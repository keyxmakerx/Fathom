import { describe, expect, it } from 'vitest';

import { addSketchPort, createSketchDevice } from './commands';
import { addFieldDef, fieldValue, fieldsOf, listFieldDefs, normalizeFieldValue, removeFieldDef, renameFieldDef, setFieldValue, setFieldValues, FieldRefusalError } from './fields';
import { edgesOut, emptyDocument, parseNodeId, type Document } from './model';
import { readPlain, writePlain } from './plain';
import { undo } from './undo';

const NOW = 1_700_000_000_000;
const ACTOR = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function deviceDoc(): { doc: Document; deviceId: string; chassisId: string; portId: string } {
  const bare = createSketchDevice(emptyDocument(), { now: NOW });
  const deviceId = bare.nodes.find((n) => parseNodeId(n.id).kind === 'Device')!.id;
  const chassisId = bare.nodes.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
  const doc = addSketchPort(bare, chassisId, { label: 'eth0', connector: 'rj45', face: 'front' }, { now: NOW });
  return { doc, deviceId, chassisId, portId: edgesOut(doc, chassisId, 'HasPort')[0]!.to };
}

describe('field definitions', () => {
  it('adds one per kind and refuses a repeated name, ignoring case', () => {
    const { doc } = deviceDoc();
    const { doc: a } = addFieldDef(doc, { name: 'Warranty ends', appliesTo: 'device', type: 'date' });
    expect(listFieldDefs(a, 'device').map((d) => d.name)).toEqual(['Warranty ends']);
    expect(listFieldDefs(a, 'rack')).toEqual([]);
    expect(() => addFieldDef(a, { name: ' warranty  ENDS ', appliesTo: 'device', type: 'text' })).toThrow(FieldRefusalError);
    expect(addFieldDef(a, { name: 'Warranty ends', appliesTo: 'rack', type: 'text' }).defId).toBeTruthy();
  });

  it('refuses a blank name', () => {
    expect(() => addFieldDef(emptyDocument(), { name: '  ', appliesTo: 'device', type: 'text' })).toThrow(FieldRefusalError);
  });

  it('renames, and a rename to a taken name is refused', () => {
    const { doc } = deviceDoc();
    const a = addFieldDef(doc, { name: 'Owner', appliesTo: 'device', type: 'text' });
    const b = addFieldDef(a.doc, { name: 'Cost centre', appliesTo: 'device', type: 'text' });
    expect(() => renameFieldDef(b.doc, b.defId, 'owner')).toThrow(FieldRefusalError);
    const renamed = renameFieldDef(b.doc, b.defId, 'Budget');
    expect(listFieldDefs(renamed, 'device').map((d) => d.name)).toEqual(['Budget', 'Owner']);
    expect(renameFieldDef(renamed, b.defId, 'Budget')).toBe(renamed);
  });
});

describe('field values', () => {
  it('sets, changes and clears a value', () => {
    const { doc, deviceId } = deviceDoc();
    const { doc: withDef, defId } = addFieldDef(doc, { name: 'Cost centre', appliesTo: 'device', type: 'text' });
    const set = setFieldValue(withDef, deviceId, defId, 'IT-204');
    expect(fieldValue(set, deviceId, defId)).toBe('IT-204');
    expect(fieldsOf(set, deviceId)).toEqual([{ def: expect.objectContaining({ name: 'Cost centre' }), value: 'IT-204' }]);
    const changed = setFieldValue(set, deviceId, defId, 'IT-300');
    expect(fieldValue(changed, deviceId, defId)).toBe('IT-300');
    const cleared = setFieldValue(changed, deviceId, defId, '  ');
    expect(fieldValue(cleared, deviceId, defId)).toBeUndefined();
    expect(setFieldValue(cleared, deviceId, defId, '')).toBe(cleared);
  });

  it('refuses a field that does not apply to the thing', () => {
    const { doc, portId } = deviceDoc();
    const { doc: withDef, defId } = addFieldDef(doc, { name: 'Owner', appliesTo: 'device', type: 'text' });
    expect(() => setFieldValue(withDef, portId, defId, 'x')).toThrow(FieldRefusalError);
  });

  it('checks each type', () => {
    expect(normalizeFieldValue('number', ' 12.5 ')).toBe('12.5');
    expect(() => normalizeFieldValue('number', '12 volts')).toThrow(FieldRefusalError);
    expect(normalizeFieldValue('yes_no', 'Y')).toBe('yes');
    expect(normalizeFieldValue('yes_no', 'false')).toBe('no');
    expect(() => normalizeFieldValue('yes_no', 'maybe')).toThrow(FieldRefusalError);
    expect(normalizeFieldValue('date', '2027-03-01')).toBe('2027-03-01');
    expect(() => normalizeFieldValue('date', '2027-02-30')).toThrow(FieldRefusalError);
    expect(normalizeFieldValue('text', '')).toBeNull();
  });

  it('writes many values as one undoable batch', () => {
    const { doc, deviceId, portId } = deviceDoc();
    const a = addFieldDef(doc, { name: 'Owner', appliesTo: 'device', type: 'text' });
    const b = addFieldDef(a.doc, { name: 'Tier', appliesTo: 'port', type: 'number' });
    const before = b.doc.batches.length;
    const next = setFieldValues(b.doc, [
      { ownerId: deviceId, defId: a.defId, raw: 'net team' },
      { ownerId: portId, defId: b.defId, raw: '2' },
    ], { actor: ACTOR, now: NOW + 2 });
    expect(next.batches.length).toBe(before + 1);
    const undone = undo(next, next.batches[next.batches.length - 1]!.id, { actor: ACTOR, now: NOW + 5 });
    expect(fieldValue(undone, deviceId, a.defId)).toBeUndefined();
  });

  it('removing a definition removes its values', () => {
    const { doc, deviceId } = deviceDoc();
    const { doc: withDef, defId } = addFieldDef(doc, { name: 'Owner', appliesTo: 'device', type: 'text' });
    const set = setFieldValue(withDef, deviceId, defId, 'x');
    const gone = removeFieldDef(set, defId);
    expect(listFieldDefs(gone, 'device')).toEqual([]);
    expect(fieldsOf(gone, deviceId)).toEqual([]);
  });

  it('survives a save and reopen', () => {
    const { doc, deviceId } = deviceDoc();
    const { doc: withDef, defId } = addFieldDef(doc, { name: 'Owner', appliesTo: 'device', type: 'text' });
    const set = setFieldValue(withDef, deviceId, defId, 'net team');
    const reopened = readPlain(writePlain(set));
    expect(fieldValue(reopened, deviceId, defId)).toBe('net team');
  });
});
