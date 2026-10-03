import { describe, expect, it } from 'vitest';

import { addAddress, interfaceChoices } from '../../document/ipam-write';
import { deriveIpam } from '../../document/ipam';
import { deriveNetworks } from '../../document/networks-derive';
import { bulkEstate } from './bulkEstate';
import { cableRows, deviceRows, portRows, rackRows, type InvRow } from './kinds';
import { buildPlaceIndex, NO_WHERE } from './placeIndex';
import { buildSearchIndex, macClue, portKey, search } from './search';
import { smallEstate } from './testFixture';
import { viewOf } from '../../document/view';
import type { Document } from '../../document/model';

const MAC = '00:1A:2B:3C:4D:5E';

function indexOf(doc: Document, tweak?: (devices: InvRow[]) => InvRow[]) {
  const view = viewOf(doc, []);
  const idx = buildPlaceIndex(doc, view);
  let devices = deviceRows(doc, view, [], idx);
  if (tweak) devices = tweak(devices);
  const prefixes = deriveIpam(doc, deriveNetworks(doc)).prefixes;
  return buildSearchIndex({ devices, ports: portRows(doc, view, idx, []), racks: rackRows(doc, view, [], idx), cables: cableRows(doc, view, idx, []), idx, prefixes });
}

function estate() {
  const e = smallEstate();
  const view = viewOf(e.doc, []);
  const idx0 = buildPlaceIndex(e.doc, view);
  const tor = deviceRows(e.doc, view, [], idx0).find((r) => r.cells.name === 'lon1-a03-tor1')!;
  const owner = interfaceChoices(e.doc, tor.deviceNodeId!)[0]!;
  const doc = addAddress(e.doc, { address: '10.20.30.41/24', owner });
  const ix = indexOf(doc, (ds) => ds.map((d) => (d.cells.name === 'lon1-b01-fw1' ? { ...d, cells: { ...d.cells, 'field:mac': MAC } } : d)));
  return { e, doc, ix };
}

const names = (o: ReturnType<typeof search>): string[] => o.groups.flatMap((g) => g.hits.map((h) => h.row.title));

describe('port names', () => {
  it('reads every vendor spelling of the same port the same way', () => {
    const a = portKey('ge-0/0/1');
    expect(portKey('Gi0/0/1')).toEqual(a);
    expect(portKey('GigabitEthernet0/0/1')).toEqual(a);
    expect(portKey('ge0/0/1')).toEqual(a);
    expect(portKey('Te1/1/1')).toEqual(portKey('xe-1/1/1'));
    expect(portKey('eno1')).not.toEqual(portKey('eno2'));
  });
});

describe('MAC clues', () => {
  it('reads a MAC however it is written', () => {
    for (const t of [MAC, MAC.toLowerCase(), '00-1a-2b-3c-4d-5e', '001a.2b3c.4d5e', '001A2B3C4D5E', '00 1a 2b 3c 4d 5e']) expect(macClue(t)).toEqual({ hex: '001a2b3c4d5e', full: true });
  });
  it('reads the start of one only when it has separators and letters', () => {
    expect(macClue('00:1a:2b')).toEqual({ hex: '001a2b', full: false });
    expect(macClue('123456')).toBeNull();
    expect(macClue('lon1-a03')).toBeNull();
  });
});

describe('MAC clues, more ways', () => {
  it('reads HP/H3C, spaced and short vendor-prefix forms', () => {
    expect(macClue('001a-2b3c-4d5e')).toEqual({ hex: '001a2b3c4d5e', full: true });
    expect(macClue('00 1a 2b 3c 4d 5e')).toEqual({ hex: '001a2b3c4d5e', full: true });
    expect(macClue('00:50:56')).toEqual({ hex: '005056', full: false });
    expect(macClue('00-50-56')).toEqual({ hex: '005056', full: false });
    expect(macClue('00:50:56:ab')).toEqual({ hex: '005056ab', full: false });
    expect(macClue('10.20.30')).toBeNull();
    expect(macClue('005056')).toBeNull();
  });

  it('finds a MAC stored in a device field or a port field, in any stored spelling', () => {
    const e = smallEstate();
    const view = viewOf(e.doc, []);
    const idx = buildPlaceIndex(e.doc, view);
    const devices = deviceRows(e.doc, view, [], idx);
    const ports = portRows(e.doc, view, idx, []);
    const dev = devices.find((d) => d.cells.name === 'lon1-b01-fw1')!;
    const port = ports[0]!;
    const ix = buildSearchIndex({
      devices: devices.map((d) => (d.key === dev.key ? { ...d, cells: { ...d.cells, 'field:mac': '001a-2b3c-4d5e' } } : d)),
      ports: ports.map((p) => (p.key === port.key ? { ...p, cells: { ...p.cells, 'field:mac': '00 50 56 aa bb cc' } } : p)),
      racks: rackRows(e.doc, view, [], idx),
      cables: cableRows(e.doc, view, idx, []),
      idx,
    });
    expect(search(ix, '001a.2b3c.4d5e', NO_WHERE).jump?.row.cells.name).toBe('lon1-b01-fw1');
    expect(search(ix, '00:1a:2b:3c:4d:5e', NO_WHERE).jump?.row.cells.name).toBe('lon1-b01-fw1');
    const p = search(ix, '00:50:56:aa:bb:cc', NO_WHERE);
    expect(p.jump?.row.key).toBe(port.key);
    expect(p.groups[0]?.kind).toBe('ports');
    // The VMware prefix finds the port too, by its start, without jumping.
    const pre = search(ix, '00:50:56', NO_WHERE);
    expect(pre.groups[0]?.hits.map((h) => h.row.key)).toContain(port.key);
    expect(pre.jump).toBeNull();
  });
});

describe('finding things', () => {
  const { ix } = estate();
  const where = NO_WHERE;

  it('a cable label, whole or in part', () => {
    const o = search(ix, 'C-10412', where);
    expect(o.reading).toContain('cable label');
    expect(names(o)).toHaveLength(1);
    expect(o.jump?.row.cells.name).toBe('C-10412');
    expect(search(ix, 'c10412', where).jump?.row.cells.name).toBe('C-10412');
    const part = search(ix, '10412', where);
    expect(part.jump).toBeNull();
    expect(part.groups[0]?.hits[0]?.how).toBe('part');
    expect(part.reading).toContain('part of a cable label');
  });

  it('a MAC address in any format, found in a field', () => {
    for (const t of [MAC, '001a.2b3c.4d5e', '00-1a-2b-3c-4d-5e', '001a2b3c4d5e']) {
      const o = search(ix, t, where);
      expect(o.jump?.row.cells.name, t).toBe('lon1-b01-fw1');
      expect(o.reading).toContain('00:1a:2b:3c:4d:5e');
    }
    const prefix = search(ix, '00:1a:2b', where);
    expect(prefix.jump).toBeNull();
    expect(prefix.groups[0]?.hits[0]?.row.cells.name).toBe('lon1-b01-fw1');
  });

  it('an IP address finds the device that has it; a prefix finds the network', () => {
    const o = search(ix, '10.20.30.41', where);
    expect(o.jump?.row.cells.name).toBe('lon1-a03-tor1');
    expect(o.reading).toContain('IP address');
    expect(search(ix, '10.20.30.41/24', where).groups[0]?.kind).toBe('prefixes');
    expect(search(ix, '10.20.30.0/24', where).jump?.row.cells.prefix).toBe('10.20.30.0/24');
    // Nobody has .99, so it names the network it would sit in.
    const none = search(ix, '10.20.30.99', where);
    expect(none.groups[0]?.kind).toBe('prefixes');
    expect(none.groups[0]?.hits[0]?.why).toContain('no device has 10.20.30.99');
    const start = search(ix, '10.20.30', where);
    expect(start.jump).toBeNull();
    expect(names(start)).toEqual(['lon1-a03-tor1']);
  });

  it('a device and port, spelled any way', () => {
    for (const t of ['core1 Gi1/0/24', 'core1 gi1/0/24', 'core1 GigabitEthernet1/0/24', 'core1 24', 'core1 1/0/24']) {
      const o = search(ix, t, where);
      expect(o.jump?.row.title, t).toBe('core1 · Gi1/0/24');
      expect(o.reading).toContain('on core1');
    }
    // Juniper spellings of the same port.
    expect(search(ix, 'lon1-a03-tor1 ge0/0/1', where).jump?.row.title).toBe('lon1-a03-tor1 · ge-0/0/1');
    expect(search(ix, 'lon1-a03-tor1 Gi0/0/1', where).jump?.row.title).toBe('lon1-a03-tor1 · ge-0/0/1');
  });

  it('a port name on its own lists it on every device that has it', () => {
    const o = search(ix, 'ge-0/0/0', where);
    expect(o.groups[0]?.kind).toBe('ports');
    expect(o.total).toBe(2);
    expect(o.jump).toBeNull();
  });

  it('a serial number, whole or in part', () => {
    expect(search(ix, 'XH12345678', where).jump?.row.cells.name).toBe('lon1-a03-tor1');
    expect(search(ix, 'xh-1234 5678', where).jump?.how).toBe('exact');
    // A fragment is not a unique answer: Enter shows the results rather than jumping.
    const part = search(ix, 'H123456', where);
    expect(part.jump).toBeNull();
    expect(part.groups[0]?.hits[0]?.how).toBe('part');
    expect(part.groups[0]?.hits[0]?.row.cells.name).toBe('lon1-a03-tor1');
  });

  it('a rack, and device names', () => {
    expect(search(ix, 'rack A04', where).jump?.row.key).toMatch(/^rack:/);
    const o = search(ix, 'lon1-a03', where);
    expect(o.jump).toBeNull();
    expect(names(o)).toEqual(expect.arrayContaining(['lon1-a03-tor1', 'lon1-a03-srv0001']));
    expect(search(ix, 'core1', where).jump?.row.cells.name).toBe('core1');
  });

  it('falls back to the nearest names and never jumps on a guess', () => {
    const o = search(ix, 'lon1-a03-trr1', where);
    expect(o.reading).toContain('nearest');
    expect(o.groups[0]?.hits[0]?.row.cells.name).toBe('lon1-a03-tor1');
    expect(o.jump).toBeNull();
    const none = search(ix, 'zzzzzzzz', where);
    expect(none.total).toBe(0);
    expect(none.reading).not.toBe('');
  });

  it('says nothing for an empty clue', () => {
    expect(search(ix, '   ', where)).toMatchObject({ total: 0, reading: '', jump: null });
  });
});

describe('Where narrows search and says what it hid', () => {
  const { ix } = estate();
  it('counts the matches outside', () => {
    const o = search(ix, 'lon1-a0', { site: 'LON1', row: 'Row A', rack: 'A03' });
    expect(names(o).sort()).toEqual(['lon1-a03-srv0001', 'lon1-a03-tor1']);
    expect(o.outside).toBe(1);
    const other = search(ix, 'lon1-a03-tor1', { site: 'MAN1', row: '', rack: '' });
    expect(other.total).toBe(0);
    expect(other.outside).toBe(1);
  });
});

describe('real-length values at scale', () => {
  const big = bulkEstate({ scale: 0.1 });
  const view = viewOf(big.doc, []);
  const idx = buildPlaceIndex(big.doc, view);
  const ix = buildSearchIndex({ devices: deviceRows(big.doc, view, [], idx), ports: portRows(big.doc, view, idx, []), racks: rackRows(big.doc, view, [], idx), cables: cableRows(big.doc, view, idx, []), idx });

  it('finds a made-up serial, a trunk label, and a ToR port', () => {
    expect(search(ix, big.known.serial, NO_WHERE).jump?.row.cells.name).toBe(big.known.serialDevice);
    expect(search(ix, big.known.trunkLabel, NO_WHERE).jump?.row.cells.name).toBe(big.known.trunkLabel);
    const p = search(ix, `${big.known.torDevice} ${big.known.torPort}`, NO_WHERE);
    expect(p.jump?.row.title).toBe(`${big.known.torDevice} · ${big.known.torPort}`);
    expect(search(ix, `${big.known.torDevice} 5`, NO_WHERE).total).toBeGreaterThan(0);
  });
});

describe('VLANs', () => {
  const vlan = (id: number, name: string, site = 'LON1'): InvRow => ({
    key: `vlan:${id}`,
    selection: null,
    ownerId: null,
    cells: { vlan: String(id), label: name, site },
    tags: [],
    ids: {},
    places: [{ site, row: '', rack: '', rackId: '', u: null }],
    title: name ? `VLAN ${id} · ${name}` : `VLAN ${id}`,
  });
  const e = smallEstate();
  const view = viewOf(e.doc, []);
  const idx = buildPlaceIndex(e.doc, view);
  const ix = buildSearchIndex({
    devices: deviceRows(e.doc, view, [], idx),
    ports: portRows(e.doc, view, idx, []),
    racks: rackRows(e.doc, view, [], idx),
    cables: cableRows(e.doc, view, idx, []),
    idx,
    vlans: [vlan(30, 'Cameras'), vlan(40, 'Voice'), vlan(300, 'Cameras-old', 'MAN1')],
  });

  it('"vlan 30" and "VLAN30" open that VLAN', () => {
    for (const t of ['vlan 30', 'VLAN30', 'vlan:30']) {
      const o = search(ix, t, NO_WHERE);
      expect(o.jump?.row.key, t).toBe('vlan:30');
      expect(o.reading).toBe('VLAN 30');
    }
  });

  it('a name finds it exactly or in part; Enter jumps only on the exact one', () => {
    expect(search(ix, 'Voice', NO_WHERE).jump?.row.key).toBe('vlan:40');
    // "Cameras" is exact for one VLAN and only part of another's name: Enter opens the exact one, the other stays listed.
    const cams = search(ix, 'Cameras', NO_WHERE);
    expect(cams.jump?.row.key).toBe('vlan:30');
    expect(cams.total).toBe(2);
    expect(search(ix, 'cameras ', NO_WHERE).jump?.row.key).toBe('vlan:30');
    const part = search(ix, 'camer', NO_WHERE);
    expect(part.groups[0]?.kind).toBe('vlans');
    expect(part.total).toBe(2);
    expect(part.jump).toBeNull();
  });

  it('two exact matches: Enter does not pick one', () => {
    const twin = buildSearchIndex({
      devices: [],
      ports: [],
      racks: [],
      cables: [],
      idx,
      vlans: [vlan(30, 'Cameras'), vlan(31, 'Cameras', 'MAN1'), vlan(300, 'Cameras-old')],
    });
    const o = search(twin, 'Cameras', NO_WHERE);
    expect(o.total).toBe(3);
    expect(o.jump).toBeNull();
    // Where can leave just one exact match, and then Enter opens it.
    expect(search(twin, 'Cameras', { site: 'MAN1', row: '', rack: '' }).jump?.row.key).toBe('vlan:31');
  });

  it('a bare number that is a VLAN id lists it without jumping, and Where narrows it', () => {
    const o = search(ix, '40', NO_WHERE);
    expect(o.groups[0]?.kind).toBe('vlans');
    expect(o.jump).toBeNull();
    const here = search(ix, 'camer', { site: 'LON1', row: '', rack: '' });
    expect(here.total).toBe(1);
    expect(here.outside).toBe(1);
  });
});
