import { describe, expect, it } from 'vitest';

import type { ChassisView, RackView } from '../document/view';
import type { CutSheetDevice } from './cutSheet';
import { buildPrintJob } from './printJob';

function chassis(id: string, positionU: number): ChassisView {
  return {
    id,
    deviceId: `device:${id}`,
    hostname: id,
    model: 'Model',
    vendor: 'Vendor',
    positionU,
    heightU: 1,
    face: 'front',
    ports: [],
    role: null,
    managementAddress: null,
    serial: null,
    psuInlets: [],
    singleFed: false,
    oneFitted: false,
    placement: { kind: 'rack', rackId: id, positionU, face: 'front' },
    sketch: false,
  };
}

function rack(id: string, label: string, heightU: number, deviceCount: number): Pick<RackView, 'id' | 'label' | 'heightU' | 'unitNumbering' | 'chassis' | 'shelves'> {
  const list: ChassisView[] = [];
  for (let u = 1; u <= deviceCount; u += 1) list.push(chassis(`${id}-c${u}`, u));
  return { id, label, heightU, unitNumbering: 'ascending', chassis: list, shelves: [] };
}

const meta = { designName: 'Drive network', path: 'Site › Building › Closet', printedBy: 'Sam K.', printedAt: new Date('2026-09-25T14:02:00') };

describe('buildPrintJob', () => {
  it('builds one unpaginated sheet per rack, in order, for "closet"', () => {
    const racks = [rack('r1', 'R1', 42, 42), rack('r2', 'R2', 4, 2)];
    const job = buildPrintJob({
      what: 'closet',
      racks,
      cables: [],
      cutSheetDevices: [],
      options: { paper: 'A4', cables: 'none', hideSensitive: false, blackAndWhite: false },
      meta,
    });
    expect(job.sheets).toHaveLength(2);
    expect(job.sheets.map((s) => (s.kind === 'rack' ? s.rackLabel : null))).toEqual(['R1', 'R2']);
    expect(job.sheets[0].kind === 'rack' && job.sheets[0].deviceRows).toHaveLength(42);
  });

  it('carries paper and black-and-white through to the job', () => {
    const job = buildPrintJob({
      what: 'this-rack',
      racks: [rack('r1', 'R1', 4, 1)],
      cables: [],
      cutSheetDevices: [],
      options: { paper: 'Letter', cables: 'none', hideSensitive: false, blackAndWhite: true },
      meta,
    });
    expect(job.paper).toBe('Letter');
    expect(job.blackAndWhite).toBe(true);
  });

  it('builds one cut-sheet sheet, not rack sheets, when "what" is the cut sheet', () => {
    const devices: CutSheetDevice[] = [{ key: 'a', name: 'a', model: 'M', placement: 'not placed', rows: [{ port: 'Et1', connector: 'rj45', farEnd: '— free', cable: '', colour: '', vlans: '' }] }];
    const job = buildPrintJob({
      what: 'cut-sheet',
      racks: [rack('r1', 'R1', 4, 1)],
      cables: [],
      cutSheetDevices: devices,
      options: { paper: 'A4', cables: 'none', hideSensitive: false, blackAndWhite: false },
      meta,
    });
    expect(job.sheets).toHaveLength(1);
    expect(job.sheets[0].kind).toBe('cutsheet');
  });

  it('names which rack a rack-sheet is, and the cables option, in the sheet label', () => {
    const job = buildPrintJob({
      what: 'this-rack',
      racks: [rack('r1', 'R7', 4, 1)],
      cables: [],
      cutSheetDevices: [],
      options: { paper: 'A4', cables: 'all', hideSensitive: false, blackAndWhite: false },
      meta,
    });
    const sheet = job.sheets[0];
    expect(sheet.heading.title).toContain('R7');
    expect(sheet.heading.detail).toContain('cables: all');
  });

  it('the cut sheet\'s label carries device and port counts', () => {
    const devices: CutSheetDevice[] = [
      { key: 'a', name: 'a', model: 'M', placement: 'not placed', rows: [{ port: 'Et1', connector: 'rj45', farEnd: '', cable: '', colour: '', vlans: '' }] },
      { key: 'b', name: 'b', model: 'M', placement: 'not placed', rows: [] },
    ];
    const job = buildPrintJob({
      what: 'cut-sheet',
      racks: [],
      cables: [],
      cutSheetDevices: devices,
      options: { paper: 'A4', cables: 'none', hideSensitive: false, blackAndWhite: false },
      meta,
    });
    expect(job.sheets[0].heading.detail).toBe('2 devices · 1 ports · by rack position, top down');
  });

  it('the rack-sheet heading names its own design, U count and device count', () => {
    const job = buildPrintJob({
      what: 'this-rack',
      racks: [rack('r1', 'R1', 24, 3)],
      cables: [],
      cutSheetDevices: [],
      options: { paper: 'A4', cables: 'none', hideSensitive: false, blackAndWhite: false },
      meta,
    });
    const sheet = job.sheets[0];
    expect(sheet.heading.title).toBe('Rack R1 · Drive network');
    expect(sheet.heading.detail).toBe('front and rear · 24U · 3 devices · cables: none');
  });
});
