// The Routing lens's marks (sign-off r101, option A), read off a drawn design.
import { describe, expect, it } from 'vitest';

import { connectPorts } from '../../document/cables';
import { addSketchPort, createSketchDevice } from '../../document/commands';
import { addAddress, interfaceChoices } from '../../document/ipam-write';
import { addEdge, addNode, begin, finish, moveFree } from '../../document/freeform';
import { edgesOut, emptyDocument, findNode, identifier, parseNodeId, token, type Document } from '../../document/model';
import { addVlan } from '../../document/networks';
import { addRoute } from '../../document/routes';
import { viewOf } from '../../document/view';
import { natRuleCount, networkOf, routingMarks, tableLit, tableNames } from './routingLens';

function addDevice(doc: Document, ports: string[]): { doc: Document; deviceId: string; chassisId: string; portIds: string[] } {
  const before = new Set(doc.nodes.map((n) => n.id));
  let next = createSketchDevice(doc);
  const fresh = next.nodes.filter((n) => !before.has(n.id));
  const deviceId = fresh.find((n) => parseNodeId(n.id).kind === 'Device')!.id;
  const chassisId = fresh.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
  const portIds: string[] = [];
  for (const label of ports) {
    const had = new Set(next.nodes.map((n) => n.id));
    next = addSketchPort(next, chassisId, { label, connector: 'rj45', face: 'front' });
    portIds.push(next.nodes.find((n) => !had.has(n.id))!.id);
  }
  return { doc: next, deviceId, chassisId, portIds };
}

function address(doc: Document, deviceId: string, label: string, cidr: string): Document {
  const owner = interfaceChoices(doc, deviceId).find((c) => c.label.startsWith(label))!;
  return addAddress(doc, { address: cidr, owner }, undefined);
}

/** router r: 10.0.1.1/24 to host a (gateway set), 10.0.2.1/24 to host b (none); switch s puts pc c in VLAN 20. */
function design() {
  const a = addDevice(emptyDocument(), ['eth0']);
  const r = addDevice(a.doc, ['0', '1']);
  const b = addDevice(r.doc, ['eth0']);
  const s = addDevice(b.doc, ['1', '2']);
  const c = addDevice(s.doc, ['eth0']);
  let doc = connectPorts(c.doc, a.portIds[0], r.portIds[0], { sheath: 'grey' });
  doc = connectPorts(doc, r.portIds[1], b.portIds[0], { sheath: 'grey' });
  doc = connectPorts(doc, s.portIds[0], c.portIds[0], { sheath: 'grey' });
  doc = address(doc, a.deviceId, 'eth0', '10.0.1.10/24');
  doc = address(doc, r.deviceId, '0', '10.0.1.1/24');
  doc = address(doc, r.deviceId, '1', '10.0.2.1/24');
  doc = address(doc, b.deviceId, 'eth0', '10.0.2.10/24');
  doc = addRoute(doc, { deviceId: a.deviceId, destination: 'default', via: '10.0.1.1' }).doc;
  doc = addVlan(doc, { vlanId: 20, attach: [{ target: { kind: 'port', portId: s.portIds[0], interfaceName: '1' } }] });
  // On the canvas, so their cables are drawn.
  doc = moveFree(doc, [a, r, b, s, c].map((x, i) => ({ id: x.chassisId, x: i * 200, y: 0 })));
  return { doc, a, r, b, s, c };
}

describe('the Routing lens', () => {
  it('names a prefix as its network', () => {
    expect(networkOf('10.0.20.7/24')).toBe('10.0.20.0/24');
    expect(networkOf('10.0.20.7')).toBeNull();
  });

  it('marks routers, gateways, hosts without one, and switches', () => {
    const d = design();
    const view = viewOf(d.doc, []);
    const m = routingMarks(d.doc, view);
    const words = (chassisId: string) => (m.devices.get(chassisId) ?? []).map((w) => `${w.caution ? '!' : ''}${w.text}`);
    expect(words(d.r.chassisId)).toEqual(['ROUTES · 1 TABLE']);
    expect(words(d.a.chassisId)).toEqual(['GW 10.0.1.1']);
    expect(words(d.b.chassisId)).toEqual(['!NO GATEWAY']);
    expect(words(d.s.chassisId)).toEqual(['SWITCHES ONLY']);
    expect(words(d.c.chassisId)).toEqual([]);
  });

  it('carries a routed link\'s prefix in ink and a switched one\'s VLANs dashed', () => {
    const d = design();
    const view = viewOf(d.doc, []);
    const m = routingMarks(d.doc, view);
    const cableOf = (portId: string) => view.cables.find((c) => c.ends.some((e) => 'portId' in e && e.portId === portId))!.id;
    const ar = cableOf(d.a.portIds[0]);
    const sc = cableOf(d.s.portIds[0]);
    expect(m.routed.has(ar)).toBe(true);
    expect(m.cables.get(ar)?.mid).toBe('10.0.1.0/24');
    expect(m.switched.has(sc)).toBe(true);
    expect(m.cables.get(sc)?.mid).toBe('VLAN 20');
    expect(m.switched.has(ar)).toBe(false);
  });

  it('says how many NAT rules a firewall keeps, after its routes (sign-off r104)', () => {
    const d = design();
    const b = begin(d.doc, {});
    const set = addNode(b, 'NatRuleSet', { 'NatRuleSet.name': identifier('from-internet'), 'NatRuleSet.nat_type': token('destination') });
    addEdge(b, 'HasNatRuleSet', d.r.deviceId, set);
    for (const name of ['web', 'mail', 'vpn']) {
      const rule = addNode(b, 'NatRule', { 'NatRule.name': identifier(name) });
      addEdge(b, 'HasNatRule', set, rule);
    }
    const doc = finish(b, 'NAT rules');
    const m = routingMarks(doc, viewOf(doc, []));
    expect((m.devices.get(d.r.chassisId) ?? []).map((w) => w.text)).toEqual(['ROUTES · 1 TABLE', 'NAT · 3 RULES']);
    expect(natRuleCount(doc, d.a.deviceId)).toBe(0);
  });

  it('draws nothing without a design', () => {
    const m = routingMarks(null, viewOf(emptyDocument(), []));
    expect(m.devices.size).toBe(0);
  });
});

/** The router keeps a VRF, cust-a, and its port 1 (to host b) is in it. */
function withVrf() {
  const d = design();
  // Host b's own gateway gives it a default table of its own; that alone does not light it with the default.
  d.doc = addRoute(d.doc, { deviceId: d.b.deviceId, destination: 'default', via: '10.0.2.1' }).doc;
  const b = begin(d.doc, {});
  const tables: Record<string, string> = {};
  for (const name of ['default', 'cust-a']) {
    tables[name] = addNode(b, 'RoutingInstance', { 'RoutingInstance.name': identifier(name), 'RoutingInstance.isolation': token('routing_table_only') });
    addEdge(b, 'HasRoutingInstance', d.r.deviceId, tables[name]);
  }
  const iface = edgesOut(d.doc, d.r.deviceId, 'HasInterface').map((e) => findNode(d.doc, e.to)!).find((n) => n.fields['Interface.name']?.value === '1')!;
  const unit = edgesOut(d.doc, iface.id, 'HasUnit')[0]!.to;
  addEdge(b, 'InRoutingInstance', unit, tables['cust-a']!);
  return { ...d, doc: finish(b, 'a VRF') };
}

describe('the Routing lens table picker', () => {
  it('offers nothing to pick until a device keeps a VRF', () => {
    const d = design();
    expect(tableNames(d.doc, viewOf(d.doc, []))).toEqual([]);
    const v = withVrf();
    expect(tableNames(v.doc, viewOf(v.doc, []))).toEqual(['default', 'cust-a']);
  });

  it('lights one table: the VRF reaches only the host on its port', () => {
    const v = withVrf();
    const view = viewOf(v.doc, []);
    const cableOf = (portId: string) => view.cables.find((c) => c.ends.some((e) => 'portId' in e && e.portId === portId))!.id;
    const cust = tableLit(v.doc, view, 'cust-a');
    expect([...cust.chassis].sort()).toEqual([v.r.chassisId, v.b.chassisId].sort());
    expect([...cust.cables]).toEqual([cableOf(v.b.portIds[0])]);
    const def = tableLit(v.doc, view, 'default');
    expect(def.chassis.has(v.a.chassisId) && def.chassis.has(v.r.chassisId)).toBe(true);
    expect(def.chassis.has(v.b.chassisId)).toBe(false);
    // The switch and its pc join no VRF device: they are in the default table.
    expect(def.chassis.has(v.s.chassisId) && def.cables.has(cableOf(v.s.portIds[0]))).toBe(true);
    expect(cust.chassis.has(v.s.chassisId)).toBe(false);
  });
});
