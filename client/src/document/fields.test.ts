import { describe, expect, it } from 'vitest';

import { addSketchPort, createSketchDevice } from './commands';
import {
  FieldRefusalError,
  fieldValue,
  fieldsOf,
  listFieldDefs,
  normalizeFieldName,
  normalizeFieldValue,
  setFieldValue,
  setFieldValues,
  type FieldDefView,
} from './fields';
import { edgesOut, emptyDocument, parseNodeId, type Document } from './model';
import { readPlain, writePlain } from './plain';
import { undo } from './undo';

const NOW = 1_700_000_000_000;
const ACTOR = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const def = (id: string, name: string, appliesTo: FieldDefView['appliesTo'], type: FieldDefView['type'] = 'text', extra: Partial<FieldDefView> = {}): FieldDefView => ({
  id,
  name,
  appliesTo,
  type,
  choices: [],
  version: 1,
  createdBy: ACTOR,
  archived: false,
  ...extra,
});

const OWNER = def('D1', 'Owner', 'device');
const TIER = def('D2', 'Tier', 'port', 'number');

function deviceDoc(): { doc: Document; deviceId: string; chassisId: string; portId: string } {
  const bare = createSketchDevice(emptyDocument(), { now: NOW });
  const deviceId = bare.nodes.find((n) => parseNodeId(n.id).kind === 'Device')!.id;
  const chassisId = bare.nodes.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
  const doc = addSketchPort(bare, chassisId, { label: 'eth0', connector: 'rj45', face: 'front' }, { now: NOW });
  return { doc, deviceId, chassisId, portId: edgesOut(doc, chassisId, 'HasPort')[0]!.to };
}

describe('field definitions (organisation store)', () => {
  it('lists live definitions of a kind by name and hides archived ones', () => {
    const defs = [def('a', 'Zone', 'device'), def('b', 'Asset tag', 'device'), def('c', 'Gone', 'device', 'text', { archived: true }), def('d', 'Row', 'rack')];
    expect(listFieldDefs(defs, 'device').map((d) => d.name)).toEqual(['Asset tag', 'Zone']);
  });

  it('refuses a blank or invisible-character name', () => {
    expect(() => normalizeFieldName('  ')).toThrow(FieldRefusalError);
    expect(() => normalizeFieldName('a‮b')).toThrow(FieldRefusalError);
    expect(normalizeFieldName('  Cost   centre ')).toBe('Cost centre');
  });
});

describe('field values', () => {
  it('sets, changes and clears a value', () => {
    const { doc, deviceId } = deviceDoc();
    const defs = [OWNER];
    const set = setFieldValue(doc, deviceId, OWNER.id, 'IT-204', defs);
    expect(fieldValue(set, deviceId, OWNER.id)).toBe('IT-204');
    expect(fieldsOf(set, deviceId, defs)).toEqual([{ def: OWNER, value: 'IT-204' }]);
    const changed = setFieldValue(set, deviceId, OWNER.id, 'IT-300', defs);
    expect(fieldValue(changed, deviceId, OWNER.id)).toBe('IT-300');
    const cleared = setFieldValue(changed, deviceId, OWNER.id, '  ', defs);
    expect(fieldValue(cleared, deviceId, OWNER.id)).toBeUndefined();
    expect(setFieldValue(cleared, deviceId, OWNER.id, '', defs)).toBe(cleared);
  });

  it('refuses a field that does not apply to the thing, or an archived one', () => {
    const { doc, portId, deviceId } = deviceDoc();
    expect(() => setFieldValue(doc, portId, OWNER.id, 'x', [OWNER])).toThrow(FieldRefusalError);
    expect(() => setFieldValue(doc, deviceId, OWNER.id, 'x', [{ ...OWNER, archived: true }])).toThrow();
  });

  it('checks each type', () => {
    const t = (type: FieldDefView['type'], choices: string[] = []) => ({ type, choices });
    expect(normalizeFieldValue(t('number'), ' 12.5 ')).toBe('12.5');
    expect(() => normalizeFieldValue(t('number'), '12 volts')).toThrow(FieldRefusalError);
    expect(normalizeFieldValue(t('choice', ['Prod', 'Test']), 'prod')).toBe('Prod');
    expect(() => normalizeFieldValue(t('choice', ['Prod', 'Test']), 'dev')).toThrow(FieldRefusalError);
    expect(normalizeFieldValue(t('url'), 'https://wiki/x')).toBe('https://wiki/x');
    expect(() => normalizeFieldValue(t('url'), 'javascript:alert(1)')).toThrow(FieldRefusalError);
    expect(normalizeFieldValue(t('date'), '2027-03-01')).toBe('2027-03-01');
    expect(() => normalizeFieldValue(t('date'), '2027-02-30')).toThrow(FieldRefusalError);
    expect(normalizeFieldValue(t('text'), '')).toBeNull();
  });

  it('writes many values as one undoable batch', () => {
    const { doc, deviceId, portId } = deviceDoc();
    const before = doc.batches.length;
    const next = setFieldValues(
      doc,
      [
        { ownerId: deviceId, defId: OWNER.id, raw: 'net team' },
        { ownerId: portId, defId: TIER.id, raw: '2' },
      ],
      [OWNER, TIER],
      { actor: ACTOR, now: NOW + 2 },
    );
    expect(next.batches.length).toBe(before + 1);
    const undone = undo(next, next.batches[next.batches.length - 1]!.id, { actor: ACTOR, now: NOW + 5 });
    expect(fieldValue(undone, deviceId, OWNER.id)).toBeUndefined();
  });

  it('keeps a value whose definition was archived and shows it as removed', () => {
    const { doc, deviceId } = deviceDoc();
    const set = setFieldValue(doc, deviceId, OWNER.id, 'x', [OWNER]);
    const rows = fieldsOf(set, deviceId, [{ ...OWNER, archived: true }]);
    expect(rows).toEqual([{ def: expect.objectContaining({ id: OWNER.id, archived: true }), value: 'x', removed: true }]);
    const unknown = fieldsOf(set, deviceId, []);
    expect(unknown[0]).toEqual(expect.objectContaining({ value: 'x', removed: true }));
  });

  it('survives a save and reopen', () => {
    const { doc, deviceId } = deviceDoc();
    const set = setFieldValue(doc, deviceId, OWNER.id, 'net team', [OWNER]);
    const reopened = readPlain(writePlain(set));
    expect(fieldValue(reopened, deviceId, OWNER.id)).toBe('net team');
  });
});
