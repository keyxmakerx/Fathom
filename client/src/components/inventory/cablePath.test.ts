import { describe, expect, it } from 'vitest';

import { viewOf } from '../../document/view';
import { bulkEstate } from './bulkEstate';
import { cablePath, pluggedInto, stationPlace } from './cablePath';
import { buildPlaceIndex } from './placeIndex';
import { smallEstate } from './testFixture';

describe('a cable on its own', () => {
  const e = smallEstate();
  const view = viewOf(e.doc, []);
  const idx = buildPlaceIndex(e.doc, view);

  it('is one cable between two stops, each with its place', () => {
    const path = cablePath(view, idx, e.cables['C-10412']!)!;
    expect(path.cables).toHaveLength(1);
    expect(path.cables[0]!.sheath).toBe('blue');
    expect(path.stations.map((s) => s.kind)).toEqual(['end', 'end']);
    const names = path.stations.map((s) => s.host).sort();
    expect(names).toEqual(['lon1-a03-srv0001', 'lon1-a03-tor1']);
    expect(stationPlace(path.stations[0]!)).toMatch(/^LON1 › Row A › A03 › U\d+$/);
  });

  it('says what a device is plugged into', () => {
    const tor = idx.ports.find((p) => p.hostName === 'lon1-a03-tor1')!.hostId;
    const list = pluggedInto(view, idx, tor);
    expect(list).toHaveLength(2);
    expect(list.find((l) => l.cableLabel === 'C-10412')?.far).toMatchObject({ host: 'lon1-a03-srv0001', port: 'eno1' });
  });
});

describe('a cable that runs through patch panels', () => {
  const big = bulkEstate({ scale: 0.05 });
  const view = viewOf(big.doc, []);
  const idx = buildPlaceIndex(big.doc, view);
  const mid = view.cables.find((c) => c.label === big.known.trunkLabel)!;

  it('is read end to end, panel by panel, front on one side and rear on the other', () => {
    const path = cablePath(view, idx, mid.id)!;
    expect(path.cables).toHaveLength(3);
    expect(path.stations.map((s) => s.kind)).toEqual(['end', 'panel', 'panel', 'end']);
    expect(path.stations[0]!.host).toBe(big.known.torDevice.replace(/-tor1$/, '-tor1'));
    expect(path.stations[3]!.host).toMatch(/-core[12]$/);
    const [rackPanel, corePanel] = [path.stations[1]!, path.stations[2]!];
    expect(rackPanel.ports.map((p) => p.face)).toEqual(['front', 'rear']);
    expect(corePanel.ports.map((p) => p.face)).toEqual(['rear', 'front']);
    // The cable asked about is the middle one, and it is found from either end of the run.
    expect(path.at).toBe(1);
    expect(path.cables[1]!.id).toBe(mid.id);
    expect(cablePath(view, idx, path.cables[0]!.id)!.cables.map((c) => c.id)).toEqual(path.cables.map((c) => c.id));
  });

  it('gives each stop a site, row, rack and unit', () => {
    const path = cablePath(view, idx, mid.id)!;
    for (const s of path.stations) expect(stationPlace(s)).toMatch(/^Northwind › LON\d Row [A-B] › LON\d-[AB]\d\d › U\d+$/);
  });
});
