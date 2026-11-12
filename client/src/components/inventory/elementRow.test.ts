import { describe, expect, it } from 'vitest';

import { edgesIn } from '../../document/model';
import { cableRows, deviceRows, portRows, rackRows } from './kinds';
import { buildPlaceIndex } from './placeIndex';
import { elementRow } from './elementRow';
import { smallEstate } from './testFixture';

describe('elementRow: a name in Checks opens the page of the row it is', () => {
  const e = smallEstate();
  const idx = buildPlaceIndex(e.doc, e.view);
  const rowsByKind = {
    devices: deviceRows(e.doc, e.view, [], idx),
    racks: rackRows(e.doc, e.view, [], idx),
    cables: cableRows(e.doc, e.view, idx),
    ports: portRows(e.doc, e.view, idx),
  };

  it('finds a device by its chassis and by its device node', () => {
    const chassisId = e.chassis['core1']!;
    const deviceId = edgesIn(e.doc, chassisId, 'HasChassis')[0]!.from;
    expect(elementRow(e.doc, rowsByKind, chassisId)).toMatchObject({ kind: 'devices', row: { title: expect.stringContaining('core1') } });
    expect(elementRow(e.doc, rowsByKind, deviceId)?.kind).toBe('devices');
    expect(elementRow(e.doc, rowsByKind, deviceId)?.row.key).toBe(elementRow(e.doc, rowsByKind, chassisId)?.row.key);
  });

  it('finds a rack, a cable and a port in their own lists', () => {
    expect(elementRow(e.doc, rowsByKind, e.rackIds['A03']!)?.kind).toBe('racks');
    expect(elementRow(e.doc, rowsByKind, Object.values(e.cables)[0]!)?.kind).toBe('cables');
    expect(elementRow(e.doc, rowsByKind, e.ports['core1']![0]!)?.kind).toBe('ports');
  });

  it('says null for an id no list holds', () => {
    expect(elementRow(e.doc, rowsByKind, e.premisesId)).toBeNull();
    expect(elementRow(e.doc, rowsByKind, 'Device:nothing')).toBeNull();
  });
});
