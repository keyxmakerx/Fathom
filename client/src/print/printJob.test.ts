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

function rack(id: string, label: string, heightU: number, deviceCount: number): Pick<RackView, 'id' | 'label' | 'heightU' | 'unitNumbering' | 'chassis'> {
  const list: ChassisView[] = [];
  for (let u = 1; u <= deviceCount; u += 1) list.push(chassis(`${id}-c${u}`, u));
  return { id, label, heightU, unitNumbering: 'ascending', chassis: list };
}

const meta = { designName: 'Hillside', path: 'Hillside › Home › Loft', printedBy: 'Sam K.', printedAt: new Date('2026-09-25T14:02:00') };

describe('buildPrintJob', () => {
  it('numbers pages globally across every rack in the closet, never resetting per rack', () => {
    const racks = [rack('r1', 'R1', 42, 42), rack('r2', 'R2', 4, 2)];
    const job = buildPrintJob({
      what: 'closet',
      racks,
      cutSheetDevices: [],
      options: { paper: 'A4', cables: 'none', hideSensitive: false, blackAndWhite: false },
      meta,
    });
    expect(job.length).toBeGreaterThan(2); // the 42U rack alone already takes two
    expect(job.map((p) => p.titleBlock.page)).toEqual(job.map((_, i) => i + 1));
    for (const page of job) expect(page.titleBlock.of).toBe(job.length);
  });

  it('carries the design, path, printed-by and date on every page', () => {
    const job = buildPrintJob({
      what: 'this-rack',
      racks: [rack('r1', 'R1', 4, 1)],
      cutSheetDevices: [],
      options: { paper: 'A4', cables: 'none', hideSensitive: false, blackAndWhite: false },
      meta,
    });
    expect(job).toHaveLength(1);
    expect(job[0].titleBlock.design).toBe('Hillside');
    expect(job[0].titleBlock.path).toBe('Hillside › Home › Loft');
    expect(job[0].titleBlock.printedBy).toBe('Sam K.');
    expect(job[0].titleBlock.date.length).toBeGreaterThan(0);
  });

  it('builds cut-sheet pages, not rack pages, when "what" is the cut sheet', () => {
    const devices: CutSheetDevice[] = [{ key: 'a', name: 'a', model: 'M', placement: 'not placed', rows: [] }];
    const job = buildPrintJob({
      what: 'cut-sheet',
      racks: [rack('r1', 'R1', 4, 1)],
      cutSheetDevices: devices,
      options: { paper: 'A4', cables: 'none', hideSensitive: false, blackAndWhite: false },
      meta,
    });
    expect(job).toHaveLength(1);
    expect(job[0].content.kind).toBe('cutsheet');
  });

  it('names which rack a rack-sheet page is, in the sheet label', () => {
    const job = buildPrintJob({
      what: 'this-rack',
      racks: [rack('r1', 'R7', 4, 1)],
      cutSheetDevices: [],
      options: { paper: 'A4', cables: 'all', hideSensitive: false, blackAndWhite: false },
      meta,
    });
    expect(job[0].titleBlock.sheetLabel).toContain('R7');
    expect(job[0].titleBlock.sheetLabel).toContain('cables: all');
  });
});
