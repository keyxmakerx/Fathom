import { describe, expect, it } from 'vitest';

import { cableRows, deviceRows, portRows, rackRows } from './kinds';
import { buildPlaceIndex, hasWhere, inWhere, whereOptions, type Place } from './placeIndex';
import { smallEstate } from './testFixture';

const P = (site: string, room: string, rack: string): Place => ({ site, room, rack, rackId: rack, u: null });

describe('Where', () => {
  it('nothing set means everything is in', () => {
    expect(hasWhere({ site: '', room: '', rack: '' })).toBe(false);
    expect(inWhere([], { site: '', room: '', rack: '' })).toBe(true);
  });

  it('a row is in when any of its places is inside every level that is set', () => {
    const cable = [P('LON1', 'Row A', 'A03'), P('LON1', 'Row B', 'B01')];
    expect(inWhere(cable, { site: 'LON1', room: '', rack: '' })).toBe(true);
    expect(inWhere(cable, { site: 'LON1', room: 'Row B', rack: '' })).toBe(true);
    expect(inWhere(cable, { site: 'LON1', room: 'Row B', rack: 'A03' })).toBe(false);
    expect(inWhere(cable, { site: 'MAN1', room: '', rack: '' })).toBe(false);
  });

  it('an unplaced thing is outside any Where; a kind with no place is never filtered', () => {
    expect(inWhere([], { site: 'LON1', room: '', rack: '' })).toBe(false);
    expect(inWhere(undefined, { site: 'LON1', room: '', rack: '' })).toBe(true);
  });

  it('each select offers only what the ones before it allow', () => {
    const racks = [P('LON1', 'Row A', 'A03'), P('LON1', 'Row A', 'A04'), P('LON1', 'Row B', 'B01'), P('MAN1', 'COMMS', 'R01')];
    expect(whereOptions(racks, { site: '', room: '', rack: '' })).toEqual({ sites: ['LON1', 'MAN1'], rooms: ['COMMS', 'Row A', 'Row B'], racks: ['A03', 'A04', 'B01', 'R01'] });
    expect(whereOptions(racks, { site: 'LON1', room: '', rack: '' })).toEqual({ sites: ['LON1', 'MAN1'], rooms: ['Row A', 'Row B'], racks: ['A03', 'A04', 'B01'] });
    expect(whereOptions(racks, { site: 'LON1', room: 'Row A', rack: '' }).racks).toEqual(['A03', 'A04']);
  });
});

describe('where each row is, on a real estate', () => {
  const e = smallEstate();
  const idx = buildPlaceIndex(e.doc, e.view);
  const devices = deviceRows(e.doc, e.view, [], idx);
  const ports = portRows(e.doc, e.view, idx, []);
  const cables = cableRows(e.doc, e.view, idx, []);
  const racks = rackRows(e.doc, e.view, [], idx);

  it('the site is the premises and the middle level is the rack row', () => {
    expect(idx.site).toBe('LON1');
    const tor = devices.find((r) => r.cells.name === 'lon1-a03-tor1')!;
    expect(tor.places).toEqual([expect.objectContaining({ site: 'LON1', room: 'Row A', rack: 'A03', u: 40 })]);
    expect(tor.facets!.rack).toEqual(['A03']);
    expect(tor.nums!.u).toBe(40);
  });

  it('every port knows its device, and the far end of its cable', () => {
    expect(ports).toHaveLength(4 + 2 + 4 + 2 + 24);
    const eno1 = ports.find((r) => r.cells.device === 'lon1-a03-srv0001' && r.cells.name === 'eno1')!;
    expect(eno1.cells.cable).toBe('lon1-a03-tor1 · ge-0/0/0');
    expect(eno1.facets!.connected).toEqual(['yes']);
    expect(ports.filter((r) => r.facets!.connected![0] === 'no')).toHaveLength(ports.length - 6);
  });

  it('a cable is in every place it touches, and answers per end', () => {
    const long = cables.find((r) => r.cells.name === 'C-10500')!;
    expect(long.places!.map((p) => p.rack).sort()).toEqual(['A04', 'B01']);
    const ends = [long.facets!['a.device']![0], long.facets!['b.device']![0]].sort();
    expect(ends).toEqual(['core1', 'lon1-a04-tor1']);
    expect([long.facets!['a.port']![0], long.facets!['b.port']![0]].sort()).toEqual(['Gi1/0/24', 'ge-0/0/0']);
    expect(long.facets!.device!.slice().sort()).toEqual(['core1', 'lon1-a04-tor1']);
    expect(long.facets!.role).toEqual(['switch']);
    expect(long.nums!.length).toBe(38);
  });

  it('Where picks the same things in every kind', () => {
    const w = { site: 'LON1', room: 'Row B', rack: '' };
    expect(devices.filter((r) => inWhere(r.places, w)).map((r) => r.cells.name).sort()).toEqual(['core1', 'lon1-b01-fw1']);
    expect(racks.filter((r) => inWhere(r.places, w)).map((r) => r.cells.name)).toEqual(['B01']);
    expect(cables.filter((r) => inWhere(r.places, w)).map((r) => r.cells.name)).toEqual(['C-10500']);
    expect(ports.filter((r) => inWhere(r.places, w))).toHaveLength(26);
  });
});
