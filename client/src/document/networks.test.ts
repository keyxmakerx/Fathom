import { describe, expect, it } from 'vitest';

import { addSketchPort, createSketchDevice } from './commands';
import {
  NetworkRefusalError,
  addSubnet,
  addVlan,
  attachToSubnet,
  attachToVlan,
  detachAddress,
  detachVlanMember,
  removeSubnetNetwork,
  removeVlanNetwork,
} from './networks';
import {
  edgesIn,
  edgesOut,
  emptyDocument,
  findNode,
  formatEdgeId,
  formatNodeId,
  parseNodeId,
  type Document,
  type FieldEntry,
} from './model';
import { newUlid } from './ulid';

const NOW = 1_700_000_000_000;

/** A bare `Device` (`HasChassis`'d, `PhysicalPort`-carrying) for `attach`
 * targets to resolve against — `commands.ts`'s sketch path, the
 * cheapest live fixture this document can hold. */
function deviceWithPorts(labels: readonly string[]): { doc: Document; deviceId: string; chassisId: string; portIds: string[] } {
  let doc = createSketchDevice(emptyDocument(), { now: NOW });
  const deviceId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Device')!.id;
  const chassisId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
  const portIds: string[] = [];
  for (const label of labels) {
    const before = new Set(doc.nodes.map((n) => n.id));
    doc = addSketchPort(doc, chassisId, { label, connector: 'rj45', face: 'front' }, { now: NOW });
    const added = doc.nodes.find((n) => !before.has(n.id) && parseNodeId(n.id).kind === 'PhysicalPort')!;
    portIds.push(added.id);
  }
  return { doc, deviceId, chassisId, portIds };
}

function vlanNodesOf(doc: Document): Array<{ id: string; deviceId: string }> {
  return doc.nodes
    .filter((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Vlan')
    .map((n) => ({ id: n.id, deviceId: edgesIn(doc, n.id, 'HasVlan')[0]!.from }));
}

/** Raw fixture: `deviceId`'s Et1 already trunks vlan 99 — the state
 * `addVlan` itself can never produce (tagged is always refused on a fresh
 * unit, "a trunk is never made here"), built directly so the "tagged onto an
 * already-trunking unit" path has something to attach a SECOND vlan onto. */
function deviceWithTrunkUnit(): { doc: Document; deviceId: string; unitId: string; interfaceId: string; portId: string } {
  const { doc, deviceId, portIds } = deviceWithPorts(['Et1']);
  const portId = portIds[0];
  const existence = (): string => newUlid(NOW);
  const ifaceId = formatNodeId('Interface', newUlid(NOW));
  const unitId = formatNodeId('LogicalUnit', newUlid(NOW));
  const oldVlanId = formatNodeId('Vlan', newUlid(NOW));
  const set = (v: FieldEntry['value']): FieldEntry => ({ presence: 'set', prov: existence(), value: v });
  const withNodes: Document = {
    ...doc,
    nodes: [
      ...doc.nodes,
      { id: ifaceId, existence: existence(), fields: { 'Interface.name': set('Et1'), 'Interface.form': set('ethernet') } },
      { id: unitId, existence: existence(), fields: { 'LogicalUnit.index': set(0) } },
      { id: oldVlanId, existence: existence(), fields: { 'Vlan.vlan_id': set('99') } },
    ],
    edges: [
      ...doc.edges,
      { id: formatEdgeId('HasInterface', newUlid(NOW)), from: deviceId, to: ifaceId, prov: existence(), fields: {} },
      { id: formatEdgeId('Occupies', newUlid(NOW)), from: ifaceId, to: portId, prov: existence(), fields: {} },
      { id: formatEdgeId('HasUnit', newUlid(NOW)), from: ifaceId, to: unitId, prov: existence(), fields: {} },
      { id: formatEdgeId('HasVlan', newUlid(NOW)), from: deviceId, to: oldVlanId, prov: existence(), fields: {} },
      {
        id: formatEdgeId('VlanMember', newUlid(NOW)),
        from: unitId,
        to: oldVlanId,
        prov: existence(),
        fields: { 'VlanMember.mode': set('trunk') },
      },
    ],
  };
  return { doc: withNodes, deviceId, unitId, interfaceId: ifaceId, portId };
}

describe('addVlan', () => {
  it('writes a bare Vlan + HasVlan on each "on" device, batch labelled for the trail', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    const next = addVlan(doc, { vlanId: 10, name: 'Servers', on: [deviceId] }, { now: NOW });
    const vlans = vlanNodesOf(next);
    expect(vlans).toHaveLength(1);
    expect(vlans[0].deviceId).toBe(deviceId);
    expect(next.batches).toHaveLength(doc.batches.length + 1);
    expect(next.batches.at(-1)!.label).toBe('add VLAN 10 · Servers');
  });

  it('refuses an id outside 1..4094', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    expect(() => addVlan(doc, { vlanId: 0, on: [deviceId] }, { now: NOW })).toThrow(NetworkRefusalError);
    expect(() => addVlan(doc, { vlanId: 4095, on: [deviceId] }, { now: NOW })).toThrow(NetworkRefusalError);
  });

  it('refuses a name that is not an Identifier', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    expect(() => addVlan(doc, { vlanId: 10, name: 'has spaces', on: [deviceId] }, { now: NOW })).toThrow(NetworkRefusalError);
  });

  it('refuses an "on" device that already has this id', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    const once = addVlan(doc, { vlanId: 10, on: [deviceId] }, { now: NOW });
    expect(() => addVlan(once, { vlanId: 10, on: [deviceId] }, { now: NOW })).toThrow(NetworkRefusalError);
  });

  it('does not mutate its input on a refusal', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    const before = JSON.stringify(doc);
    expect(() => addVlan(doc, { vlanId: 9000, on: [deviceId] }, { now: NOW })).toThrow();
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('untagged onto a bare port creates Interface + HasInterface + Occupies + HasUnit + VlanMember{access}', () => {
    const { doc, deviceId, portIds } = deviceWithPorts(['Et1']);
    const next = addVlan(
      doc,
      { vlanId: 10, attach: [{ target: { kind: 'port', portId: portIds[0], interfaceName: 'Et1' } }] },
      { now: NOW },
    );
    const iface = next.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Interface');
    expect(iface).toBeDefined();
    expect(edgesOut(next, deviceId, 'HasInterface').map((e) => e.to)).toContain(iface!.id);
    expect(edgesOut(next, iface!.id, 'Occupies').map((e) => e.to)).toEqual([portIds[0]]);
    const unit = next.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'LogicalUnit');
    expect(unit).toBeDefined();
    expect(edgesOut(next, iface!.id, 'HasUnit').map((e) => e.to)).toEqual([unit!.id]);
    const vm = edgesOut(next, unit!.id, 'VlanMember')[0];
    expect(vm.fields['VlanMember.mode']).toMatchObject({ presence: 'set', value: 'access' });
  });

  it('refuses a duplicate interface name on the same device', () => {
    const { doc, portIds } = deviceWithPorts(['Et1', 'Et2']);
    const once = addVlan(doc, { vlanId: 10, attach: [{ target: { kind: 'port', portId: portIds[0], interfaceName: 'Et1' } }] }, { now: NOW });
    expect(() =>
      addVlan(once, { vlanId: 20, attach: [{ target: { kind: 'port', portId: portIds[1], interfaceName: 'Et1' } }] }, { now: NOW }),
    ).toThrow(NetworkRefusalError);
  });

  it('refuses tagged onto a unit that does not already trunk ("a trunk is never made here")', () => {
    const { doc, portIds } = deviceWithPorts(['Et1']);
    expect(() =>
      addVlan(doc, { vlanId: 10, attach: [{ target: { kind: 'port', portId: portIds[0], interfaceName: 'Et1' }, tagged: true }] }, { now: NOW }),
    ).toThrow(NetworkRefusalError);
  });

  it('accepts tagged onto a unit that already trunks', () => {
    const { doc, unitId } = deviceWithTrunkUnit();
    const next = addVlan(doc, { vlanId: 30, attach: [{ target: { kind: 'unit', unitId }, tagged: true }] }, { now: NOW });
    const memberships = edgesOut(next, unitId, 'VlanMember').filter((e) => e.absentSince === undefined);
    expect(memberships).toHaveLength(2);
  });

  it('refuses untagged onto a unit already in another VLAN', () => {
    const { doc, unitId } = deviceWithTrunkUnit();
    expect(() => addVlan(doc, { vlanId: 30, attach: [{ target: { kind: 'unit', unitId } }] }, { now: NOW })).toThrow(NetworkRefusalError);
  });

  it('gateway writes an Address and an L3Interface edge, unit index = vlan id, even untagged', () => {
    const { doc, portIds } = deviceWithPorts(['igc1']);
    const next = addVlan(
      doc,
      {
        vlanId: 50,
        attach: [{ target: { kind: 'port', portId: portIds[0], interfaceName: 'igc1' }, tagged: false, gateway: true }],
        subnet: '10.0.50.0/24',
        gatewayAddress: '10.0.50.1/24',
      },
      { now: NOW },
    );
    const unit = next.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'LogicalUnit')!;
    expect(unit.fields['LogicalUnit.index']).toMatchObject({ value: 50 });
    expect(unit.fields['LogicalUnit.vlan_id']).toMatchObject({ value: '50' });
    const addr = next.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Address')!;
    expect(addr.fields['Address.value']).toMatchObject({ value: '10.0.50.1/24' });
    expect(edgesOut(next, unit.id, 'HasAddress').map((e) => e.to)).toEqual([addr.id]);
    const vlan = vlanNodesOf(next)[0];
    expect(edgesOut(next, vlan.id, 'L3Interface').map((e) => e.to)).toEqual([unit.id]);
    const vm = edgesOut(next, unit.id, 'VlanMember')[0];
    expect(vm.fields['VlanMember.mode']).toMatchObject({ value: 'trunk' });
  });

  it('a gateway needs no pre-existing trunk — "a trunk is never made here" does not gate it', () => {
    const { doc, portIds } = deviceWithPorts(['igc1']);
    expect(() =>
      addVlan(
        doc,
        { vlanId: 50, attach: [{ target: { kind: 'port', portId: portIds[0], interfaceName: 'igc1' }, gateway: true }], gatewayAddress: '10.0.50.1/24' },
        { now: NOW },
      ),
    ).not.toThrow();
  });

  it('a plain tagged attach onto a reused trunk unit does not get LogicalUnit.vlan_id stamped', () => {
    const { doc, unitId } = deviceWithTrunkUnit();
    const next = addVlan(doc, { vlanId: 30, attach: [{ target: { kind: 'unit', unitId }, tagged: true }] }, { now: NOW });
    expect(next.nodes.find((n) => n.id === unitId)!.fields['LogicalUnit.vlan_id']).toBeUndefined();
  });

  it('a second access port on the same device joins the same VLAN row instead of refusing', () => {
    const { doc, portIds } = deviceWithPorts(['Et1', 'Et2']);
    const once = addVlan(doc, { vlanId: 10, attach: [{ target: { kind: 'port', portId: portIds[0], interfaceName: 'Et1' } }] }, { now: NOW });
    const twice = addVlan(once, { vlanId: 10, attach: [{ target: { kind: 'port', portId: portIds[1], interfaceName: 'Et2' } }] }, { now: NOW });
    expect(vlanNodesOf(twice)).toHaveLength(1);
    const units = twice.nodes.filter((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'LogicalUnit');
    expect(units).toHaveLength(2);
  });

  it('refuses a second gateway in one call', () => {
    const { doc, portIds } = deviceWithPorts(['Et1', 'Et2']);
    expect(() =>
      addVlan(
        doc,
        {
          vlanId: 10,
          attach: [
            { target: { kind: 'port', portId: portIds[0], interfaceName: 'Et1' }, gateway: true },
            { target: { kind: 'port', portId: portIds[1], interfaceName: 'Et2' }, gateway: true },
          ],
          gatewayAddress: '10.0.10.1/24',
        },
        { now: NOW },
      ),
    ).toThrow(NetworkRefusalError);
  });

  it('refuses a subnet with no gateway unit', () => {
    const { doc, portIds } = deviceWithPorts(['Et1']);
    expect(() =>
      addVlan(
        doc,
        { vlanId: 10, attach: [{ target: { kind: 'port', portId: portIds[0], interfaceName: 'Et1' } }], subnet: '10.0.10.0/24' },
        { now: NOW },
      ),
    ).toThrow(NetworkRefusalError);
  });

  it('refuses a gateway outside the subnet', () => {
    const { doc, portIds } = deviceWithPorts(['Et1']);
    expect(() =>
      addVlan(
        doc,
        {
          vlanId: 10,
          attach: [{ target: { kind: 'port', portId: portIds[0], interfaceName: 'Et1' }, gateway: true }],
          subnet: '10.0.10.0/24',
          gatewayAddress: '10.0.99.1/24',
        },
        { now: NOW },
      ),
    ).toThrow(NetworkRefusalError);
  });

  it('refuses attaching onto an AggregateInterface (a bond)', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    const aggId = formatNodeId('AggregateInterface', newUlid(NOW));
    const withAgg: Document = {
      ...doc,
      nodes: [...doc.nodes, { id: aggId, existence: newUlid(NOW), fields: { 'AggregateInterface.name': { presence: 'set', prov: newUlid(NOW), value: 'ae0' } } }],
      edges: [...doc.edges, { id: formatEdgeId('HasInterface', newUlid(NOW)), from: deviceId, to: aggId, prov: newUlid(NOW), fields: {} }],
    };
    expect(() => addVlan(withAgg, { vlanId: 10, attach: [{ target: { kind: 'interface', interfaceId: aggId } }] }, { now: NOW })).toThrow(
      NetworkRefusalError,
    );
  });

  it('refuses a gateway onto a unit already an access member of another VLAN', () => {
    const { doc, portIds } = deviceWithPorts(['Et1']);
    const access = addVlan(doc, { vlanId: 10, attach: [{ target: { kind: 'port', portId: portIds[0], interfaceName: 'Et1' } }] }, { now: NOW });
    const unitId = access.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'LogicalUnit')!.id;
    expect(() =>
      addVlan(access, { vlanId: 20, attach: [{ target: { kind: 'unit', unitId }, gateway: true }], gatewayAddress: '10.0.20.1/24' }, { now: NOW }),
    ).toThrow(NetworkRefusalError);
  });
});

describe('attachToVlan', () => {
  it('refuses when the VLAN id does not exist anywhere yet', () => {
    const { doc, portIds } = deviceWithPorts(['Et1']);
    expect(() =>
      attachToVlan(doc, { vlanId: 10, target: { kind: 'port', portId: portIds[0], interfaceName: 'Et1' } }, { now: NOW }),
    ).toThrow(NetworkRefusalError);
  });

  it('joins a second device to an established VLAN id', () => {
    const a = deviceWithPorts(['Et1']);
    const withFirst = addVlan(a.doc, { vlanId: 10, on: [a.deviceId] }, { now: NOW });
    const b = deviceWithPorts(['Et1']);
    // merge b's device into the same document
    const merged: Document = { ...withFirst, nodes: [...withFirst.nodes, ...b.doc.nodes], edges: [...withFirst.edges, ...b.doc.edges] };
    const next = attachToVlan(merged, { vlanId: 10, target: { kind: 'port', portId: b.portIds[0], interfaceName: 'Et1' } }, { now: NOW });
    expect(vlanNodesOf(next)).toHaveLength(2);
  });
});

describe('addSubnet', () => {
  it('writes an Address + HasAddress, and the name box writes the unit description', () => {
    const { doc, portIds } = deviceWithPorts(['wg0']);
    const next = addSubnet(
      doc,
      { prefix: '10.8.0.0/24', attach: [{ target: { kind: 'port', portId: portIds[0], interfaceName: 'wg0' }, address: '10.8.0.1/24', name: 'Road warriors' }] },
      { now: NOW },
    );
    const unit = next.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'LogicalUnit')!;
    expect(unit.fields['LogicalUnit.description']).toMatchObject({ value: 'Road warriors' });
    const addr = next.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Address')!;
    expect(addr.fields['Address.value']).toMatchObject({ value: '10.8.0.1/24' });
  });

  it('refuses host bits in the prefix', () => {
    const { doc, portIds } = deviceWithPorts(['wg0']);
    expect(() =>
      addSubnet(doc, { prefix: '10.8.0.1/24', attach: [{ target: { kind: 'port', portId: portIds[0], interfaceName: 'wg0' }, address: '10.8.0.1/24' }] }, { now: NOW }),
    ).toThrow(NetworkRefusalError);
  });

  it('refuses an address outside the prefix', () => {
    const { doc, portIds } = deviceWithPorts(['wg0']);
    expect(() =>
      addSubnet(doc, { prefix: '10.8.0.0/24', attach: [{ target: { kind: 'port', portId: portIds[0], interfaceName: 'wg0' }, address: '10.9.0.1/24' }] }, { now: NOW }),
    ).toThrow(NetworkRefusalError);
  });

  it('refuses by name, not a bare RangeError, when the unit already carries an undeclared family', () => {
    const { doc, portIds } = deviceWithPorts(['ge-0/0/1']);
    const port = portIds[0];
    const ifaceId = formatNodeId('Interface', newUlid(NOW));
    const unitId = formatNodeId('LogicalUnit', newUlid(NOW));
    const withRaw: Document = {
      ...doc,
      nodes: [
        ...doc.nodes,
        { id: ifaceId, existence: newUlid(NOW), fields: { 'Interface.name': { presence: 'set', prov: newUlid(NOW), value: 'ge-0/0/1' } } },
        { id: unitId, existence: newUlid(NOW), fields: { 'LogicalUnit.index': { presence: 'set', prov: newUlid(NOW), value: 0 }, 'LogicalUnit.families': { presence: 'set', prov: newUlid(NOW), value: ['vpls'] } } },
      ],
      edges: [
        ...doc.edges,
        { id: formatEdgeId('HasInterface', newUlid(NOW)), from: doc.nodes.find((n) => parseNodeId(n.id).kind === 'Device')!.id, to: ifaceId, prov: newUlid(NOW), fields: {} },
        { id: formatEdgeId('Occupies', newUlid(NOW)), from: ifaceId, to: port, prov: newUlid(NOW), fields: {} },
        { id: formatEdgeId('HasUnit', newUlid(NOW)), from: ifaceId, to: unitId, prov: newUlid(NOW), fields: {} },
      ],
    };
    expect(() =>
      addSubnet(withRaw, { prefix: '10.8.0.0/24', attach: [{ target: { kind: 'unit', unitId }, address: '10.8.0.1/24' }] }, { now: NOW }),
    ).toThrow(NetworkRefusalError);
  });

  it('refuses an address already on that unit', () => {
    const { doc, portIds } = deviceWithPorts(['wg0']);
    const once = addSubnet(
      doc,
      { prefix: '10.8.0.0/24', attach: [{ target: { kind: 'port', portId: portIds[0], interfaceName: 'wg0' }, address: '10.8.0.1/24' }] },
      { now: NOW },
    );
    const unit = once.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'LogicalUnit')!;
    expect(() =>
      addSubnet(once, { prefix: '10.8.0.0/24', attach: [{ target: { kind: 'unit', unitId: unit.id }, address: '10.8.0.1/24' }] }, { now: NOW }),
    ).toThrow(NetworkRefusalError);
  });
});

describe('attachToSubnet', () => {
  it('refuses when the prefix has no existing member yet', () => {
    const { doc, portIds } = deviceWithPorts(['wg0']);
    expect(() =>
      attachToSubnet(doc, { prefix: '10.8.0.0/24', target: { kind: 'port', portId: portIds[0], interfaceName: 'wg0' }, address: '10.8.0.2/24' }, { now: NOW }),
    ).toThrow(NetworkRefusalError);
  });
});

describe('detachVlanMember / removeVlanNetwork', () => {
  it('detach tombstones only the VlanMember edge, never the interface or unit', () => {
    const { doc, portIds } = deviceWithPorts(['Et1']);
    const withVlan = addVlan(doc, { vlanId: 10, attach: [{ target: { kind: 'port', portId: portIds[0], interfaceName: 'Et1' } }] }, { now: NOW });
    const unit = withVlan.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'LogicalUnit')!;
    const vm = edgesOut(withVlan, unit.id, 'VlanMember')[0];
    const next = detachVlanMember(withVlan, vm.id, { now: NOW });
    expect(findEdgeLive(next, vm.id)).toBeUndefined();
    expect(findNode(next, unit.id)?.absentSince).toBeUndefined();
  });

  it('removeVlanNetwork tombstones the Vlan node, HasVlan, VlanMember and L3Interface', () => {
    const { doc, portIds } = deviceWithPorts(['igc1']);
    const withVlan = addVlan(
      doc,
      {
        vlanId: 50,
        attach: [{ target: { kind: 'port', portId: portIds[0], interfaceName: 'igc1' }, gateway: true }],
        gatewayAddress: '10.0.50.1/24',
      },
      { now: NOW },
    );
    const vlan = vlanNodesOf(withVlan)[0];
    const next = removeVlanNetwork(withVlan, [vlan.id], { now: NOW });
    expect(findNode(next, vlan.id)?.absentSince).toBeDefined();
    expect(edgesOut(next, vlan.id, 'L3Interface')).toHaveLength(0);
  });

  it('removeVlanNetwork refuses an unknown Vlan node', () => {
    const { doc } = deviceWithPorts([]);
    expect(() => removeVlanNetwork(doc, [formatNodeId('Vlan', newUlid(NOW))], { now: NOW })).toThrow(NetworkRefusalError);
  });
});

describe('detachAddress / removeSubnetNetwork', () => {
  it('detach tombstones only the Address node, never the unit', () => {
    const { doc, portIds } = deviceWithPorts(['wg0']);
    const withAddr = addSubnet(
      doc,
      { prefix: '10.8.0.0/24', attach: [{ target: { kind: 'port', portId: portIds[0], interfaceName: 'wg0' }, address: '10.8.0.1/24' }] },
      { now: NOW },
    );
    const addr = withAddr.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Address')!;
    const unit = withAddr.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'LogicalUnit')!;
    const next = detachAddress(withAddr, addr.id, { now: NOW });
    expect(findNode(next, addr.id)?.absentSince).toBeDefined();
    expect(findNode(next, unit.id)?.absentSince).toBeUndefined();
  });

  it('removeSubnetNetwork refuses an unknown Address node', () => {
    const { doc } = deviceWithPorts([]);
    expect(() => removeSubnetNetwork(doc, [formatNodeId('Address', newUlid(NOW))], { now: NOW })).toThrow(NetworkRefusalError);
  });
});

function findEdgeLive(doc: Document, id: string) {
  const e = doc.edges.find((x) => x.id === id);
  return e && e.absentSince === undefined ? e : undefined;
}
