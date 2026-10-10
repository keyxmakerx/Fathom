import { describe, expect, it } from 'vitest';

import { addSketchPort, createSketchDevice } from './commands';
import { addEdge, addNode, begin, finish, setNodeField } from './freeform';
import { edgesIn, edgesOut, emptyDocument, interfaceName, parseNodeId, token, type Document } from './model';
import { TieRefusal, addPortsFromConfig, allPortNameRules, citedPortNameRules, isCited, positionOf, tiePlan, tiePorts, tiedPairs, untie, type PortNameRule } from './portTies';
import { undo } from './undo';

const NOW = 1_700_000_000_000;
const OPTS = { now: NOW, actor: 'test' };

/** A cited copy of the file's Junos rule, so the matcher can be exercised before a real page is cited. */
const JUNOS: PortNameRule = {
  ...allPortNameRules().find((r) => r.id === 'junos.type-fpc-pic-port')!,
  source: { cite: 'fixture', url: 'https://example.invalid/naming', read_on: '2026-10-09' },
};

interface Fixture {
  doc: Document;
  deviceId: string;
  chassisId: string;
  ports: Record<string, string>;
  ifaces: Record<string, string>;
}

/** A drawn device on `platform` with `ports` (label -> position or null) and pasted interfaces. */
function device(platform: string, ports: Record<string, { slot: number; subslot: number; index: number } | null>, ifaces: string[]): Fixture {
  let doc = createSketchDevice(emptyDocument(), OPTS);
  const deviceId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Device')!.id;
  const chassisId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
  const portIds: Record<string, string> = {};
  for (const [label, pos] of Object.entries(ports)) {
    const before = new Set(doc.nodes.map((n) => n.id));
    doc = addSketchPort(doc, chassisId, { label, connector: 'rj45', face: 'front' }, OPTS);
    portIds[label] = doc.nodes.find((n) => !before.has(n.id))!.id;
    if (pos) {
      const b = begin(doc, OPTS);
      setNodeField(b, portIds[label], 'PhysicalPort.position', pos);
      doc = finish(b, 'position');
    }
  }
  const b = begin(doc, OPTS);
  setNodeField(b, deviceId, 'Device.platform', token(platform));
  const ifaceIds: Record<string, string> = {};
  for (const name of ifaces) {
    if (name.startsWith('ae')) {
      ifaceIds[name] = addNode(b, 'AggregateInterface', { 'AggregateInterface.name': interfaceName(name) });
    } else {
      const form = name.startsWith('lo') ? 'loopback' : name.startsWith('irb') ? 'irb' : 'ethernet';
      ifaceIds[name] = addNode(b, 'Interface', { 'Interface.name': interfaceName(name), 'Interface.form': token(form) });
    }
    addEdge(b, 'HasInterface', deviceId, ifaceIds[name]);
  }
  return { doc: finish(b, 'paste'), deviceId, chassisId, ports: portIds, ifaces: ifaceIds };
}

const at = (index: number) => ({ slot: 0, subslot: 0, index });

describe('the rules file', () => {
  it('ships no cited rule yet, so nothing suggests', () => {
    expect(allPortNameRules().length).toBeGreaterThan(0);
    expect(citedPortNameRules()).toEqual([]);
    for (const r of allPortNameRules()) {
      expect(r.source === null ? r.wanted : r.source.read_on).toBeTruthy();
      expect(() => new RegExp(r.pattern)).not.toThrow();
    }
  });

  it('a rule without a dated vendor page is not cited', () => {
    expect(isCited(JUNOS)).toBe(true);
    expect(isCited({ ...JUNOS, source: null })).toBe(false);
    expect(isCited({ ...JUNOS, source: { cite: 'x', url: 'https://a', read_on: 'September' } })).toBe(false);
    expect(isCited({ ...JUNOS, source: { cite: 'x', url: '', read_on: '2026-10-09' } })).toBe(false);
  });
});

describe('suggestions', () => {
  it.each([
    ['junos-ex', 'ge-0/0/3', { slot: 0, subslot: 0, index: 3 }],
    ['junos-srx', 'xe-0/1/2', { slot: 0, subslot: 1, index: 2 }],
    ['junos-ex', 'ge-0/0/3.0', null],
    ['junos-ex', 'ae0', null],
    ['junos-ex', 'irb', null],
    ['edgeos', 'ge-0/0/3', null],
    ['opnsense', 'igb0', null],
  ])('%s %s reads as %j', (platform, name, want) => {
    expect(positionOf(name, platform, [JUNOS])).toEqual(want === null ? null : { ...want });
  });

  it('an uncited rule suggests nothing', () => {
    expect(positionOf('ge-0/0/3', 'junos-ex', [{ ...JUNOS, source: null }])).toBeNull();
    const f = device('junos-ex', { '3': at(3) }, ['ge-0/0/3']);
    expect(tiePlan(f.doc, f.deviceId, [{ ...JUNOS, source: null }])!.rows).toEqual([{ interfaceId: f.ifaces['ge-0/0/3'], name: 'ge-0/0/3', suggested: null }]);
  });

  it('suggests the port at the cited position, and leaves the rest under Not tied', () => {
    const f = device('junos-ex', { '0': at(0), '1': at(1), '2': null }, ['ge-0/0/1', 'ge-0/0/0', 'ge-0/0/2', 'ge-0/0/9']);
    const plan = tiePlan(f.doc, f.chassisId, [JUNOS])!;
    expect(plan.deviceId).toBe(f.deviceId);
    expect(plan.rows.map((r) => [r.name, r.suggested])).toEqual([
      ['ge-0/0/0', f.ports['0']],
      ['ge-0/0/1', f.ports['1']],
      ['ge-0/0/2', null],
      ['ge-0/0/9', null],
    ]);
    expect(plan.ports.map((p) => p.label)).toEqual(['port 0', 'port 1', 'port 2']);
  });

  it('never offers logical interfaces', () => {
    const f = device('junos-ex', { '0': at(0) }, ['ge-0/0/0', 'lo0', 'irb', 'ae0']);
    expect(tiePlan(f.doc, f.deviceId, [JUNOS])!.rows.map((r) => r.name)).toEqual(['ge-0/0/0']);
  });
});

describe('tying', () => {
  it('creates only Occupies edges, as the person, in one undo step that removes them', () => {
    const f = device('junos-ex', { '0': at(0), '1': at(1) }, ['ge-0/0/0', 'ge-0/0/1']);
    const before = f.doc;
    const next = tiePorts(before, f.deviceId, [
      { interfaceId: f.ifaces['ge-0/0/0'], portId: f.ports['0'] },
      { interfaceId: f.ifaces['ge-0/0/1'], portId: f.ports['1'] },
    ], OPTS);
    expect(next.batches.length).toBe(before.batches.length + 1);
    const batch = next.batches.at(-1)!;
    expect(batch.ops.map((o) => o.type)).toEqual(['add_edge', 'add_edge']);
    expect(batch.ops.every((o) => o.type === 'add_edge' && o.edge.startsWith('occupies:'))).toBe(true);
    expect(next.nodes.length).toBe(before.nodes.length);
    for (const o of batch.ops) {
      const prov = next.provenance.find((p) => o.type === 'add_edge' && p.id === o.prov)!;
      expect(prov.origin).toEqual({ kind: 'hand' });
      expect(prov.assertedBy).toBe('test');
    }
    expect(edgesOut(next, f.ifaces['ge-0/0/0'], 'Occupies').map((e) => e.to)).toEqual([f.ports['0']]);

    const undone = undo(next, batch.id, OPTS);
    expect(edgesOut(undone, f.ifaces['ge-0/0/0'], 'Occupies')).toEqual([]);
    expect(edgesOut(undone, f.ifaces['ge-0/0/1'], 'Occupies')).toEqual([]);
  });

  // The engine refuses a second paste onto a device that already carries one, so "a re-paste keeps ties" is held
  // here: a later plan never lists a tied interface and never moves a tie.
  it('keeps ties already made: a later plan lists only untied interfaces and free ports', () => {
    const f = device('junos-ex', { '0': at(0), '1': at(1) }, ['ge-0/0/0', 'ge-0/0/1']);
    const tied = tiePorts(f.doc, f.deviceId, [{ interfaceId: f.ifaces['ge-0/0/0'], portId: f.ports['1'] }], OPTS);
    const plan = tiePlan(tied, f.deviceId, [JUNOS])!;
    expect(plan.rows.map((r) => r.name)).toEqual(['ge-0/0/1']);
    // Port 1 is taken (by hand, against the rule), so ge-0/0/1 is not moved onto it.
    expect(plan.rows[0].suggested).toBeNull();
    expect(plan.ports.map((p) => p.label)).toEqual(['port 0']);
    expect(() => tiePorts(tied, f.deviceId, [{ interfaceId: f.ifaces['ge-0/0/0'], portId: f.ports['0'] }], OPTS)).toThrow(TieRefusal);
  });

  it('refuses a taken port, a port twice, and another device\'s port', () => {
    const f = device('junos-ex', { '0': at(0) }, ['ge-0/0/0', 'ge-0/0/1']);
    const g = device('junos-ex', { '5': at(5) }, ['ge-0/0/5']);
    const both: Document = { ...f.doc, nodes: [...f.doc.nodes, ...g.doc.nodes], edges: [...f.doc.edges, ...g.doc.edges], provenance: [...f.doc.provenance, ...g.doc.provenance] };
    expect(() => tiePorts(both, f.deviceId, [{ interfaceId: f.ifaces['ge-0/0/0'], portId: g.ports['5'] }], OPTS)).toThrow(TieRefusal);
    expect(() => tiePorts(both, f.deviceId, [{ interfaceId: g.ifaces['ge-0/0/5'], portId: f.ports['0'] }], OPTS)).toThrow(TieRefusal);
    expect(() =>
      tiePorts(f.doc, f.deviceId, [
        { interfaceId: f.ifaces['ge-0/0/0'], portId: f.ports['0'] },
        { interfaceId: f.ifaces['ge-0/0/1'], portId: f.ports['0'] },
      ], OPTS),
    ).toThrow(TieRefusal);
  });
});

describe('untying', () => {
  it('lists ties and removes one in one undo step, leaving interface and port', () => {
    const f = device('junos-ex', { '0': at(0) }, ['ge-0/0/0']);
    const tied = tiePorts(f.doc, f.deviceId, [{ interfaceId: f.ifaces['ge-0/0/0'], portId: f.ports['0'] }], OPTS);
    expect(tiedPairs(tied, f.deviceId)).toEqual([{ interfaceId: f.ifaces['ge-0/0/0'], name: 'ge-0/0/0', port: 'port 0' }]);
    const loose = untie(tied, f.ifaces['ge-0/0/0'], OPTS);
    expect(loose.batches.length).toBe(tied.batches.length + 1);
    expect(tiedPairs(loose, f.deviceId)).toEqual([]);
    expect(tiePlan(loose, f.deviceId, [JUNOS])!.rows.map((r) => r.suggested)).toEqual([f.ports['0']]);
    expect(() => untie(loose, f.ifaces['ge-0/0/0'], OPTS)).toThrow(TieRefusal);
  });

  it('does not offer an interface with no form whose name is not a jack', () => {
    const f = device('junos-ex', { '0': at(0) }, ['ge-0/0/0']);
    const b = begin(f.doc, OPTS);
    const v = addNode(b, 'Interface', { 'Interface.name': interfaceName('vlan') });
    addEdge(b, 'HasInterface', f.deviceId, v);
    expect(tiePlan(finish(b, 'paste'), f.deviceId, [JUNOS])!.rows.map((r) => r.name)).toEqual(['ge-0/0/0']);
  });
});

describe('adding ports from the config', () => {
  it('is offered only for a drawn device with no ports, and ties each new unlabelled port in one step', () => {
    const f = device('junos-ex', {}, ['ge-0/0/0', 'ge-0/0/1', 'lo0']);
    expect(tiePlan(f.doc, f.deviceId)!.canAddPorts).toBe(true);
    const next = addPortsFromConfig(f.doc, f.deviceId, OPTS);
    expect(next.batches.length).toBe(f.doc.batches.length + 1);
    const ports = edgesOut(next, f.chassisId, 'HasPort').map((e) => next.nodes.find((n) => n.id === e.to)!);
    expect(ports.length).toBe(2);
    for (const p of ports) {
      expect(p.fields['PhysicalPort.label']).toBeUndefined();
      expect(edgesIn(next, p.id, 'Occupies').length).toBe(1);
    }
    expect(tiePlan(next, f.deviceId)!.rows).toEqual([]);

    const withPort = device('junos-ex', { '0': null }, ['ge-0/0/0']);
    expect(tiePlan(withPort.doc, withPort.deviceId)!.canAddPorts).toBe(false);
    expect(() => addPortsFromConfig(withPort.doc, withPort.deviceId, OPTS)).toThrow(TieRefusal);
  });
});
