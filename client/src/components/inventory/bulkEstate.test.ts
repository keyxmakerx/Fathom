import { describe, expect, it } from 'vitest';

import { viewOf } from '../../document/view';
import { bulkEstate } from './bulkEstate';
import { cableRows, deviceRows, portRows, rackRows } from './kinds';
import { buildPlaceIndex } from './placeIndex';

describe('the made-up estate', () => {
  it('reads back through the closet view with the counts it reports', () => {
    const e = bulkEstate({ scale: 0.05 });
    const view = viewOf(e.doc, []);
    const idx = buildPlaceIndex(e.doc, view);
    const devices = deviceRows(e.doc, view, [], idx);
    const ports = portRows(e.doc, view, idx, []);
    const cables = cableRows(e.doc, view, idx, []);
    const racks = rackRows(e.doc, view, [], idx);
    expect(devices.length).toBe(e.stats.devices);
    expect(ports.length).toBe(e.stats.ports);
    expect(cables.length).toBe(e.stats.cables);
    expect(racks.length).toBe(e.stats.racks);
    expect(devices.some((d) => d.cells.serial === e.known.serial)).toBe(true);
  });

  it('is repeatable', () => {
    const a = bulkEstate({ scale: 0.02, seed: 3 });
    const b = bulkEstate({ scale: 0.02, seed: 3 });
    expect(a.stats).toEqual(b.stats);
    expect(a.doc.nodes.length).toBe(b.doc.nodes.length);
  });
});
