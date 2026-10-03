import { describe, expect, it } from 'vitest';

import { cableRows, deviceRows, portRows, rackRows } from './kinds';
import { buildPlaceIndex, hasWhere, inWhere, whereOptions, type Place } from './placeIndex';
import { createRack, createSketchDevice, movePlacement } from '../../document/commands';
import { setRackField } from '../../document/edit';
import { formatNodeId, parseNodeId, type Document } from '../../document/model';
import { newUlid } from '../../document/ulid';
import { viewOfAll } from '../../document/view';
import { smallEstate, T0 } from './testFixture';

const P = (site: string, row: string, rack: string): Place => ({ site, row, rack, rackId: rack, u: null });

describe('Where', () => {
  it('nothing set means everything is in', () => {
    expect(hasWhere({ site: '', row: '', rack: '' })).toBe(false);
    expect(inWhere([], { site: '', row: '', rack: '' })).toBe(true);
  });

  it('a row is in when any of its places is inside every level that is set', () => {
    const cable = [P('LON1', 'Row A', 'A03'), P('LON1', 'Row B', 'B01')];
    expect(inWhere(cable, { site: 'LON1', row: '', rack: '' })).toBe(true);
    expect(inWhere(cable, { site: 'LON1', row: 'Row B', rack: '' })).toBe(true);
    expect(inWhere(cable, { site: 'LON1', row: 'Row B', rack: 'A03' })).toBe(false);
    expect(inWhere(cable, { site: 'MAN1', row: '', rack: '' })).toBe(false);
  });

  it('an unplaced thing is outside any Where; a kind with no place is never filtered', () => {
    expect(inWhere([], { site: 'LON1', row: '', rack: '' })).toBe(false);
    expect(inWhere(undefined, { site: 'LON1', row: '', rack: '' })).toBe(true);
  });

  it('each select offers only what the ones before it allow', () => {
    const racks = [P('LON1', 'Row A', 'A03'), P('LON1', 'Row A', 'A04'), P('LON1', 'Row B', 'B01'), P('MAN1', 'COMMS', 'R01')];
    expect(whereOptions(racks, { site: '', row: '', rack: '' })).toEqual({ sites: ['LON1', 'MAN1'], rows: ['COMMS', 'Row A', 'Row B'], racks: ['A03', 'A04', 'B01', 'R01'] });
    expect(whereOptions(racks, { site: 'LON1', row: '', rack: '' })).toEqual({ sites: ['LON1', 'MAN1'], rows: ['Row A', 'Row B'], racks: ['A03', 'A04', 'B01'] });
    expect(whereOptions(racks, { site: 'LON1', row: 'Row A', rack: '' }).racks).toEqual(['A03', 'A04']);
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
    expect(tor.places).toEqual([expect.objectContaining({ site: 'LON1', row: 'Row A', rack: 'A03', u: 40 })]);
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
    const w = { site: 'LON1', row: 'Row B', rack: '' };
    expect(devices.filter((r) => inWhere(r.places, w)).map((r) => r.cells.name).sort()).toEqual(['core1', 'lon1-b01-fw1']);
    expect(racks.filter((r) => inWhere(r.places, w)).map((r) => r.cells.name)).toEqual(['B01']);
    expect(cables.filter((r) => inWhere(r.places, w)).map((r) => r.cells.name)).toEqual(['C-10500']);
    expect(ports.filter((r) => inWhere(r.places, w))).toHaveLength(26);
  });
});

describe('every Premises is a site, not only the first', () => {
  function twoPremises() {
    const e = smallEstate();
    const prov = newUlid(T0);
    const p2 = formatNodeId('Premises', newUlid(T0 + 1));
    let doc: Document = { ...e.doc, nodes: [...e.doc.nodes, { id: p2, existence: prov, fields: { 'Premises.label': { presence: 'set', prov, value: 'MAN1' } } }] };
    const before = doc;
    doc = createRack(doc, p2, { label: 'M01', heightU: 42, unitNumbering: 'ascending', now: T0 });
    const rackId = doc.nodes.find((n) => !before.nodes.some((b) => b.id === n.id) && parseNodeId(n.id).kind === 'Rack')!.id;
    doc = setRackField(doc, rackId, 'row', 'Comms', { now: T0 });
    const b2 = doc;
    doc = createSketchDevice(doc, { hostname: 'man1-sw1', now: T0 });
    const chassisId = doc.nodes.find((n) => !b2.nodes.some((b) => b.id === n.id) && parseNodeId(n.id).kind === 'Chassis')!.id;
    doc = movePlacement(doc, chassisId, { kind: 'rack', rackId, positionU: 10, face: 'front' }, { now: T0 });
    return { doc, p2 };
  }

  it('the Where bar lists both sites, with the rows and racks of each', () => {
    const { doc } = twoPremises();
    const view = viewOfAll(doc, []);
    const idx = buildPlaceIndex(doc, view);
    expect(view.premises).toHaveLength(2);
    const opts = whereOptions(idx.racks.values(), { site: '', row: '', rack: '' });
    expect(opts.sites).toEqual(['LON1', 'MAN1']);
    expect(whereOptions(idx.racks.values(), { site: 'MAN1', row: '', rack: '' })).toMatchObject({ rows: ['Comms'], racks: ['M01'] });
  });

  it('devices in the second premises are listed, placed at their own site, and Where finds them', () => {
    const { doc, p2 } = twoPremises();
    const view = viewOfAll(doc, []);
    const idx = buildPlaceIndex(doc, view);
    const devices = deviceRows(doc, view, [], idx);
    const man = devices.find((r) => r.cells.name === 'man1-sw1')!;
    expect(man.places).toEqual([expect.objectContaining({ site: 'MAN1', row: 'Comms', rack: 'M01' })]);
    expect(devices.filter((r) => inWhere(r.places, { site: 'MAN1', row: '', rack: '' })).map((r) => r.cells.name)).toEqual(['man1-sw1']);
    expect(devices.filter((r) => inWhere(r.places, { site: 'LON1', row: '', rack: '' }))).toHaveLength(5);
    expect(idx.premisesOfSite.get('MAN1')).toBe(p2);
    expect(rackRows(doc, view, [], idx).map((r) => r.cells.name)).toContain('M01');
  });

  it('two premises with the same label stay two sites', () => {
    const { doc } = twoPremises();
    const renamed: Document = { ...doc, nodes: doc.nodes.map((n) => (n.id.startsWith('Premises') || parseNodeId(n.id).kind === 'Premises' ? { ...n, fields: { ...n.fields, 'Premises.label': { presence: 'set' as const, prov: newUlid(T0), value: 'HQ' } } } : n)) };
    const idx = buildPlaceIndex(renamed, viewOfAll(renamed, []));
    expect(whereOptions(idx.racks.values(), { site: '', row: '', rack: '' }).sites).toEqual(['HQ', 'HQ (2)']);
  });
});
