import { describe, expect, it } from 'vitest';

import { addSketchPort, createSketchDevice, createSurface, fixTo } from './commands';
import { createPremises } from '../components/racks/emptyDesign';
import { setDeviceField } from './edit';
import { GRID_CELLS, buildGrid, deriveIpam, formatIpv4, freeRuns, nextFree, parseCidr, parseIpv4, prefixText, rangeOf, usedIn } from './ipam';
import { addAddress, addVlanOnDevice, interfaceChoices, pastePrefixRows, pasteVlanRows, NEEDS_OWNER } from './ipam-write';
import { emptyDocument, parseNodeId, replaceNode, type Document } from './model';
import { addSubnet, addVlan } from './networks';
import { deriveNetworks } from './networks-derive';

const NOW = 1_700_000_000_000;
let tick = 0;
const at = () => ({ now: NOW + (tick += 1) * 1000 });

function device(doc: Document, hostname: string, ports: readonly string[], role?: string): { doc: Document; deviceId: string; portIds: string[] } {
  const before = new Set(doc.nodes.map((n) => n.id));
  let working = createSketchDevice(doc, { hostname, ...at() });
  const deviceId = working.nodes.find((n) => !before.has(n.id) && parseNodeId(n.id).kind === 'Device')!.id;
  const chassisId = working.nodes.find((n) => !before.has(n.id) && parseNodeId(n.id).kind === 'Chassis')!.id;
  if (role) working = setDeviceField(working, deviceId, 'role', role, at());
  const portIds: string[] = [];
  for (const label of ports) {
    const seen = new Set(working.nodes.map((n) => n.id));
    working = addSketchPort(working, chassisId, { label, connector: 'rj45', face: 'front' }, at());
    portIds.push(working.nodes.find((n) => !seen.has(n.id) && parseNodeId(n.id).kind === 'PhysicalPort')!.id);
  }
  return { doc: working, deviceId, portIds };
}

function put(doc: Document, prefix: string, address: string, portId: string, name: string): Document {
  return addSubnet(doc, { prefix, attach: [{ target: { kind: 'port', portId, interfaceName: name }, address }] }, at());
}

describe('IPv4 arithmetic', () => {
  it('parses addresses and rejects everything else without throwing', () => {
    expect(parseIpv4('10.0.20.1')).toBe(167777281);
    expect(formatIpv4(167777281)).toBe('10.0.20.1');
    for (const bad of ['10.0.20', '256.1.1.1', '01.2.3.4', 'fe80::1', '', '1.2.3.4.5', '10.0.0.1/24']) expect(parseIpv4(bad)).toBeUndefined();
    expect(parseCidr('10.0.20.5/24')).toEqual({ ip: parseIpv4('10.0.20.5'), len: 24 });
    expect(parseCidr('10.0.20.5')?.len).toBe(32);
    for (const bad of ['10.0.20.5/33', '2001:db8::1/64', '10.0.0.1/', '10.0.0.1/24/1']) expect(parseCidr(bad)).toBeUndefined();
  });

  it('counts usable addresses the way people do', () => {
    const total = (p: string) => rangeOf(parseCidr(p)!.ip, parseCidr(p)!.len).total;
    expect(total('10.0.20.0/24')).toBe(254);
    expect(total('10.0.30.0/26')).toBe(62);
    expect(total('192.168.99.0/28')).toBe(14);
    expect(total('10.0.0.0/31')).toBe(2);
    expect(total('10.0.0.7/32')).toBe(1);
    expect(total('10.0.0.0/16')).toBe(65534);
    expect(prefixText(rangeOf(parseIpv4('10.0.20.77')!, 24))).toBe('10.0.20.0/24');
    expect(rangeOf(0, 0).size).toBe(2 ** 32);
  });

  it('finds the next free address and the free stretches', () => {
    const r = rangeOf(parseIpv4('10.0.20.0')!, 24);
    const ip = (n: number) => parseIpv4(`10.0.20.${n}`)!;
    const used = usedIn(r, [ip(1), ip(15), ip(16), ip(0), ip(255)]);
    expect(used.size).toBe(3); // network and broadcast are not usable
    expect(formatIpv4(nextFree(r, used)!)).toBe('10.0.20.2');
    expect(freeRuns(r, used).map((x) => `${formatIpv4(x.from)}-${formatIpv4(x.to)}`)).toEqual(['10.0.20.2-10.0.20.14', '10.0.20.17-10.0.20.254']);
    const all = usedIn(r, Array.from({ length: 254 }, (_, i) => ip(i + 1)));
    expect(nextFree(r, all)).toBeNull();
    expect(freeRuns(r, all)).toEqual([]);
  });

  it('draws one cell per address up to 256, a coarse grid beyond', () => {
    const r24 = rangeOf(parseIpv4('10.0.20.0')!, 24);
    const ip = (n: number) => parseIpv4(`10.0.20.${n}`)!;
    const fine = buildGrid(r24, usedIn(r24, [ip(1), ip(16)]), new Set([ip(16)]));
    expect(fine.perCell).toBe(1);
    expect(fine.cells).toHaveLength(254);
    expect(fine.cells[0]).toMatchObject({ state: 'used' });
    expect(fine.cells[15]).toMatchObject({ state: 'shared' });
    expect(fine.cells[1]).toMatchObject({ state: 'free' });

    const r16 = rangeOf(parseIpv4('172.16.0.0')!, 16);
    const coarse = buildGrid(r16, usedIn(r16, [parseIpv4('172.16.1.1')!, parseIpv4('172.16.255.254')!]));
    expect(coarse.cells).toHaveLength(GRID_CELLS);
    expect(coarse.perCell).toBe(256);
    expect(coarse.cells.filter((c) => c.state === 'used')).toHaveLength(2);
    expect(coarse.cells[1]).toMatchObject({ used: 1, state: 'used' });
    expect(coarse.cells[255]).toMatchObject({ used: 1 });

    const r8 = rangeOf(parseIpv4('10.0.0.0')!, 8);
    expect(buildGrid(r8, new Set()).perCell).toBe(65536);
    expect(buildGrid(rangeOf(0, 0), new Set()).cells).toHaveLength(GRID_CELLS);
  });
});

describe('deriveIpam', () => {
  function lab() {
    const fw = device(emptyDocument(), 'fw-01', ['e0', 'e1', 'e2', 'e3'], 'firewall');
    const nas1 = device(fw.doc, 'nas-01', ['eth0']);
    const nas2 = device(nas1.doc, 'nas-02', ['eth0']);
    const cam = device(nas2.doc, 'cam-07', ['eth0']);
    let doc = cam.doc;
    doc = addVlan(doc, { vlanId: 20, name: 'Storage', attach: [{ target: { kind: 'port', portId: fw.portIds[0], interfaceName: 'e0' }, gateway: true }], subnet: '10.0.20.0/24', gatewayAddress: '10.0.20.1/24' }, at());
    doc = put(doc, '10.0.20.0/24', '10.0.20.15/24', nas1.portIds[0], 'eth0');
    doc = put(doc, '10.0.20.0/24', '10.0.20.16/24', nas2.portIds[0], 'eth0');
    doc = put(doc, '10.0.20.0/24', '10.0.20.16/24', cam.portIds[0], 'eth0');
    doc = put(doc, '10.0.10.0/24', '10.0.10.1/24', fw.portIds[1], 'e1');
    doc = put(doc, '172.16.0.0/16', '172.16.9.9/16', fw.portIds[2], 'e2');
    return { doc, fw, nas1, nas2, cam };
  }

  it('lists a prefix with its used count, VLAN, gateway and next free address', () => {
    const { doc } = lab();
    const { prefixes } = deriveIpam(doc, deriveNetworks(doc));
    expect(prefixes.map((p) => p.prefix)).toEqual(['10.0.10.0/24', '10.0.20.0/24', '172.16.0.0/16']);
    const storage = prefixes.find((p) => p.prefix === '10.0.20.0/24')!;
    expect(storage).toMatchObject({ used: 3, total: 254, nextFree: '10.0.20.2', vlan: { vlanId: 20, name: 'Storage' } });
    expect(storage.gateway).toEqual({ address: '10.0.20.1', deviceId: expect.any(String), deviceName: 'fw-01', inferred: false });
    expect(storage.entries.map((e) => e.ip)).toEqual(['10.0.20.1', '10.0.20.15', '10.0.20.16', '10.0.20.16']);
    expect(storage.entries[0]).toMatchObject({ deviceName: 'fw-01', interfaceLabel: 'e0.20', source: 'typed' });
  });

  it('marks the same address on two devices, and counts it once', () => {
    const { doc } = lab();
    const storage = deriveIpam(doc, deriveNetworks(doc)).prefixes.find((p) => p.prefix === '10.0.20.0/24')!;
    expect(storage.clashes).toBe(1);
    const twice = storage.entries.filter((e) => e.ip === '10.0.20.16');
    expect(twice).toHaveLength(2);
    expect(twice.map((e) => e.alsoOn).sort()).toEqual([['cam-07'], ['nas-02']]);
    expect(storage.entries.filter((e) => e.alsoOn.length === 0)).toHaveLength(2);
  });

  it('takes a gateway from the one router or firewall address when no VLAN flags one, and says so', () => {
    const { doc } = lab();
    const users = deriveIpam(doc, deriveNetworks(doc)).prefixes.find((p) => p.prefix === '10.0.10.0/24')!;
    expect(users.gateway).toMatchObject({ address: '10.0.10.1', deviceName: 'fw-01', inferred: true });
    expect(users.vlan).toBeNull();
    const big = deriveIpam(doc, deriveNetworks(doc)).prefixes.find((p) => p.prefix === '172.16.0.0/16')!;
    expect(big).toMatchObject({ used: 1, total: 65534, nextFree: '172.16.0.1' });
  });

  it('lists VLANs with their prefixes and devices', () => {
    const { doc } = lab();
    const { vlans } = deriveIpam(doc, deriveNetworks(doc));
    expect(vlans).toHaveLength(1);
    expect(vlans[0]).toMatchObject({ vlanId: 20, name: 'Storage', prefixes: ['10.0.20.0/24'], deviceNames: ['fw-01'] });
  });

  it('reads the site off the premises a device is placed in, and leaves unplaced devices blank', () => {
    const { doc, fw } = lab();
    expect(deriveIpam(doc, deriveNetworks(doc)).prefixes.every((p) => p.sites.length === 0)).toBe(true);
    const premises = createPremises(doc, at());
    const wall = createSurface(premises.doc, premises.premisesId, { label: 'Wall 1', form: 'wall', ...at() });
    const surfaceId = wall.nodes.find((n) => parseNodeId(n.id).kind === 'Surface')!.id;
    const chassisId = wall.edges.find((e) => e.from === fw.deviceId && parseNodeId(e.to).kind === 'Chassis')!.to;
    const placed = fixTo(wall, chassisId, surfaceId, { xMm: 100, yMm: 100 }, at());
    const { prefixes, vlans } = deriveIpam(placed, deriveNetworks(placed));
    const label = prefixes.find((p) => p.prefix === '10.0.10.0/24')!.sites[0]!;
    expect(label).toBeTruthy();
    expect(prefixes.find((p) => p.prefix === '10.0.20.0/24')!.sites).toEqual([label]);
    expect(vlans[0]!.sites).toEqual([label]);
  });

  it('reads where an address came from off its provenance', () => {
    const { doc } = lab();
    const entry = deriveIpam(doc, deriveNetworks(doc)).prefixes[0]!.entries[0]!;
    const node = doc.nodes.find((n) => n.id === entry.addressNodeId)!;
    const prov = doc.provenance.map((p) => (p.id === node.existence ? { ...p, origin: { kind: 'parsed' as const, capture: 'c1', span: { start: 0, end: 1 } } } : p));
    const parsed = { ...doc, provenance: prov };
    expect(deriveIpam(parsed, deriveNetworks(parsed)).prefixes[0]!.entries[0]!.source).toBe('pasted config');
  });

  it('lists an IPv6 address as unreadable rather than throwing', () => {
    const { doc, fw } = lab();
    const withV6 = put(doc, '10.0.40.0/24', '10.0.40.1/24', fw.portIds[3], 'e3');
    const addr = withV6.nodes.find((n) => n.fields['Address.value']?.presence === 'set' && n.fields['Address.value'].value === '10.0.40.1/24')!;
    const v6 = replaceNode(withV6, addr.id, (n) => ({ ...n, fields: { ...n.fields, 'Address.value': { ...n.fields['Address.value']!, value: '2001:db8::1/64' } } }));
    const { prefixes } = deriveIpam(v6, deriveNetworks(v6));
    const row = prefixes.find((p) => p.prefix === '2001:db8::1/64')!;
    expect(row).toMatchObject({ readable: false, used: 0, total: 0, nextFree: null });
    expect(row.entries).toHaveLength(1);
    expect(prefixes[prefixes.length - 1]).toBe(row); // unreadable rows sort last
  });

  it('does not call a shared VRRP address a clash', () => {
    const { doc } = lab();
    const twice = doc.nodes.filter((n) => n.fields['Address.value']?.presence === 'set' && n.fields['Address.value'].value === '10.0.20.16/24');
    let working = doc;
    for (const n of twice) {
      working = replaceNode(working, n.id, (x) => ({ ...x, fields: { ...x.fields, 'Address.vrrp_group': { presence: 'set', prov: x.fields['Address.value']!.prov, value: 7 } } }));
    }
    const storage = deriveIpam(working, deriveNetworks(working)).prefixes.find((p) => p.prefix === '10.0.20.0/24')!;
    expect(storage.clashes).toBe(0);
  });
});

describe('writing from Inventory', () => {
  it('refuses a prefix with no device interface to live on', () => {
    expect(() => addAddress(emptyDocument(), { prefix: '10.0.40.0/24', address: '10.0.40.1/24', owner: null })).toThrow(NEEDS_OWNER);
    expect(() => addVlanOnDevice(emptyDocument(), { vlanId: 30, deviceId: null })).toThrow('Put it on a device.');
  });

  it('writes an address to the interface as one undo step and names a bad address plainly', () => {
    const d = device(emptyDocument(), 'sw-01', ['Et1']);
    const owner = interfaceChoices(d.doc, d.deviceId)[0]!;
    expect(owner.label).toBe('Et1 (port)');
    const next = addAddress(d.doc, { prefix: '10.0.40.0/24', address: '10.0.40.9/24', owner }, at());
    expect(next.batches.length).toBe(d.doc.batches.length + 1);
    expect(deriveIpam(next, deriveNetworks(next)).prefixes[0]).toMatchObject({ prefix: '10.0.40.0/24', used: 1 });
    // The interface exists now; a second address goes on its existing unit.
    const again = interfaceChoices(next, d.deviceId)[0]!;
    expect(again.target.kind).toBe('unit');
    const two = addAddress(next, { prefix: '10.0.40.0/24', address: '10.0.40.10/24', owner: again }, at());
    expect(deriveIpam(two, deriveNetworks(two)).prefixes[0]!.used).toBe(2);
    expect(() => addAddress(next, { prefix: '10.0.40.0/24', address: '10.0.50.1/24', owner: again })).toThrow('not inside 10.0.40.0/24');
    expect(() => addAddress(next, { prefix: '10.0.40.0/24', address: '10.0.40.9/24', owner: again })).toThrow('already has this address');
    expect(() => addAddress(next, { prefix: '10.0.40.5/24', address: '10.0.40.7/24', owner: again })).toThrow('not a network address');
  });

  it('puts a VLAN on a device', () => {
    const d = device(emptyDocument(), 'sw-01', []);
    const next = addVlanOnDevice(d.doc, { vlanId: 30, name: 'Cameras', deviceId: d.deviceId }, at());
    expect(deriveIpam(next, deriveNetworks(next)).vlans[0]).toMatchObject({ vlanId: 30, name: 'Cameras', deviceNames: ['sw-01'] });
    expect(() => addVlanOnDevice(next, { vlanId: 30, deviceId: d.deviceId })).toThrow('already has VLAN 30');
    expect(() => addVlanOnDevice(next, { vlanId: 5000, deviceId: d.deviceId })).toThrow('1 to 4094');
    expect(() => addVlanOnDevice(next, { vlanId: 31, name: 'two words', deviceId: d.deviceId })).toThrow('no spaces');
  });

  it('pastes rows as one undo step and says which rows it could not place', () => {
    const d = device(emptyDocument(), 'sw-01', ['Et1', 'Et2']);
    const first = addAddress(d.doc, { prefix: '10.0.1.0/24', address: '10.0.1.1/24', owner: interfaceChoices(d.doc, d.deviceId)[0]! }, at());
    const table = [
      ['Prefix', 'Address', 'Device', 'Interface'],
      ['10.0.1.0/24', '10.0.1.5/24', 'sw-01', 'Et2'],
      ['10.0.2.0/24', '10.0.2.5/24', 'sw-01', 'Et1'],
      ['10.0.3.0/24', '10.0.3.5/24', '', ''],
      ['', '10.0.4.5/24', 'sw-01', 'Et2'],
      ['10.0.5.0/24', '', 'sw-01', 'Et1'],
    ];
    const r = pastePrefixRows(first, table, at());
    expect(r.done).toBe(3);
    expect(r.refused).toHaveLength(2);
    expect(r.refused.every((m) => m.includes(NEEDS_OWNER.replace('.', '')))).toBe(true);
    expect(r.doc.batches.length).toBe(first.batches.length + 1);
    expect(r.doc.batches[first.batches.length]!.label).toBe('paste addresses');
    const prefixes = deriveIpam(r.doc, deriveNetworks(r.doc)).prefixes.map((p) => p.prefix);
    expect(prefixes).toEqual(['10.0.1.0/24', '10.0.2.0/24', '10.0.4.0/24']);
  });

  it('pastes VLANs onto devices', () => {
    const d = device(emptyDocument(), 'sw-01', []);
    const r = pasteVlanRows(d.doc, [['VLAN', 'Name', 'Device'], ['10', 'Users', 'sw-01'], ['20', 'Voice', 'nowhere'], ['x', '', 'sw-01']], at());
    expect(r.done).toBe(1);
    expect(r.refused).toHaveLength(2);
    expect(r.doc.batches.length).toBe(d.doc.batches.length + 1);
    expect(deriveIpam(r.doc, deriveNetworks(r.doc)).vlans.map((v) => v.vlanId)).toEqual([10]);
  });
});
