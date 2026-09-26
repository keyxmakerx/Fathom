import { describe, expect, it } from 'vitest';

import { addSketchPort, createSketchDevice } from './commands';
import { connectPorts } from './cables';
import { setDeviceField } from './edit';
import { addSubnet, addVlan } from './networks';
import { cablesCarryingVlan, deriveNetworks } from './networks-derive';
import {
  emptyDocument,
  formatEdgeId,
  formatNodeId,
  parseNodeId,
  type Document,
  type FieldEntry,
  type GraphEdge,
  type GraphNode,
} from './model';
import { newUlid } from './ulid';

const NOW = 1_700_000_000_000;

function deviceWithPorts(labels: readonly string[]): { doc: Document; deviceId: string; portIds: string[] } {
  let doc = createSketchDevice(emptyDocument(), { now: NOW });
  const deviceId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Device')!.id;
  const chassisId = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
  const portIds: string[] = [];
  for (const label of labels) {
    const before = new Set(doc.nodes.map((n) => n.id));
    doc = addSketchPort(doc, chassisId, { label, connector: 'rj45', face: 'front' }, { now: NOW });
    portIds.push(doc.nodes.find((n) => !before.has(n.id) && parseNodeId(n.id).kind === 'PhysicalPort')!.id);
  }
  return { doc, deviceId, portIds };
}

/** Two sketch devices, each with one port, uncabled — the caller cables
 * them (or not) per test. */
function twoDevices(): { doc: Document; a: { deviceId: string; portId: string }; b: { deviceId: string; portId: string } } {
  const first = deviceWithPorts(['Et1']);
  const second = deviceWithPorts(['Et1']);
  const doc: Document = {
    ...emptyDocument(),
    nodes: [...first.doc.nodes, ...second.doc.nodes],
    edges: [...first.doc.edges, ...second.doc.edges],
    provenance: [...first.doc.provenance, ...second.doc.provenance],
    batches: [...first.doc.batches, ...second.doc.batches],
  };
  return { doc, a: { deviceId: first.deviceId, portId: first.portIds[0] }, b: { deviceId: second.deviceId, portId: second.portIds[0] } };
}

describe('deriveNetworks — VLAN rows', () => {
  it('one device with one VLAN is a single trivially-joined row', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    const withVlan = addVlan(doc, { vlanId: 20, name: 'Clients', on: [deviceId] }, { now: NOW });
    const { vlanRows } = deriveNetworks(withVlan);
    expect(vlanRows).toHaveLength(1);
    expect(vlanRows[0]).toMatchObject({ vlanId: 20, name: 'Clients', joined: true, devices: [deviceId] });
  });

  it('two cabled devices carrying the same VLAN id join into one row', () => {
    const { doc, a, b } = twoDevices();
    const cabled = connectPorts(doc, a.portId, b.portId, {}, { now: NOW });
    const withA = addVlan(cabled, { vlanId: 10, attach: [{ target: { kind: 'port', portId: a.portId, interfaceName: 'Et1' } }] }, { now: NOW });
    const withBoth = addVlan(withA, { vlanId: 10, attach: [{ target: { kind: 'port', portId: b.portId, interfaceName: 'Et1' } }] }, { now: NOW });
    const { vlanRows } = deriveNetworks(withBoth);
    expect(vlanRows).toHaveLength(1);
    expect(vlanRows[0].joined).toBe(true);
    expect(vlanRows[0].devices.sort()).toEqual([a.deviceId, b.deviceId].sort());
    expect(vlanRows[0].members).toHaveLength(2);
    const memberOnA = vlanRows[0].members.find((m) => m.deviceId === a.deviceId)!;
    expect(memberOnA.farDeviceId).toBe(b.deviceId);
    expect(memberOnA.farIsSameDevice).toBe(false);
  });

  it('an uncabled second device with the same id is marked "same id, not joined"', () => {
    const { doc, a, b } = twoDevices();
    const withA = addVlan(doc, { vlanId: 30, attach: [{ target: { kind: 'port', portId: a.portId, interfaceName: 'Et1' } }] }, { now: NOW });
    const withBoth = addVlan(withA, { vlanId: 30, attach: [{ target: { kind: 'port', portId: b.portId, interfaceName: 'Et1' } }] }, { now: NOW });
    const { vlanRows } = deriveNetworks(withBoth);
    const rowsFor30 = vlanRows.filter((r) => r.vlanId === 30);
    expect(rowsFor30).toHaveLength(2);
    expect(rowsFor30.every((r) => r.joined === false)).toBe(true);
    expect(rowsFor30.map((r) => r.devices[0]).sort()).toEqual([a.deviceId, b.deviceId].sort());
  });

  it('a gateway unit\'s address becomes the row\'s cidr', () => {
    const { doc, deviceId, portIds } = deviceWithPorts(['igc1']);
    const withVlan = addVlan(
      doc,
      {
        vlanId: 50,
        attach: [{ target: { kind: 'port', portId: portIds[0], interfaceName: 'igc1' }, gateway: true }],
        subnet: '10.0.50.0/24',
        gatewayAddress: '10.0.50.1/24',
      },
      { now: NOW },
    );
    const { vlanRows } = deriveNetworks(withVlan);
    expect(vlanRows).toHaveLength(1);
    expect(vlanRows[0].cidr).toBe('10.0.50.0/24');
    expect(vlanRows[0].devices).toEqual([deviceId]);
    expect(vlanRows[0].members[0].isGateway).toBe(true);
  });

  it('a pasted interface with no Occupies falls back to Interface.name, marked', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    const withVlan = addVlan(doc, { vlanId: 10, on: [deviceId] }, { now: NOW });
    // Attach a unit directly onto a fresh Interface with no Occupies at all
    // (no port drawn) -- raw fixture, since every command-built attachment
    // always draws Occupies.
    const ifaceId = formatNodeId('Interface', newUlid(NOW));
    const unitId = formatNodeId('LogicalUnit', newUlid(NOW));
    const vlanNodeId = withVlan.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Vlan')!.id;
    const withRaw: Document = {
      ...withVlan,
      nodes: [
        ...withVlan.nodes,
        { id: ifaceId, existence: newUlid(NOW), fields: { 'Interface.name': { presence: 'set', prov: newUlid(NOW), value: 'ge-0/0/1' } } },
        { id: unitId, existence: newUlid(NOW), fields: { 'LogicalUnit.index': { presence: 'set', prov: newUlid(NOW), value: 0 } } },
      ],
      edges: [
        ...withVlan.edges,
        { id: formatEdgeId('HasInterface', newUlid(NOW)), from: deviceId, to: ifaceId, prov: newUlid(NOW), fields: {} },
        { id: formatEdgeId('HasUnit', newUlid(NOW)), from: ifaceId, to: unitId, prov: newUlid(NOW), fields: {} },
        {
          id: formatEdgeId('VlanMember', newUlid(NOW)),
          from: unitId,
          to: vlanNodeId,
          prov: newUlid(NOW),
          fields: { 'VlanMember.mode': { presence: 'set', prov: newUlid(NOW), value: 'access' } },
        },
      ],
    };
    const { vlanRows } = deriveNetworks(withRaw);
    const member = vlanRows[0].members.find((m) => m.unitId === unitId)!;
    expect(member.interfaceLabelIsFallback).toBe(true);
    expect(member.interfaceLabel).toBe('ge-0/0/1');
  });

  it('walks a PassThrough hop to find the far interface', () => {
    const { doc, a, b } = twoDevices();
    // A passive patch panel: front port F terminates A's cable, rear port R
    // terminates B's cable, PassThrough F<->R joins them.
    const frontId = formatNodeId('PhysicalPort', newUlid(NOW));
    const rearId = formatNodeId('PhysicalPort', newUlid(NOW));
    const withPanel: Document = {
      ...doc,
      nodes: [
        ...doc.nodes,
        { id: frontId, existence: newUlid(NOW), fields: { 'PhysicalPort.connector': { presence: 'set', prov: newUlid(NOW), value: 'rj45' } } },
        { id: rearId, existence: newUlid(NOW), fields: { 'PhysicalPort.connector': { presence: 'set', prov: newUlid(NOW), value: 'rj45' } } },
      ],
      edges: [...doc.edges, { id: formatEdgeId('PassThrough', newUlid(NOW)), from: frontId, to: rearId, prov: newUlid(NOW), fields: {} }],
    };
    const cabled1 = connectPorts(withPanel, a.portId, frontId, {}, { now: NOW });
    const cabled2 = connectPorts(cabled1, rearId, b.portId, {}, { now: NOW });
    const withA = addVlan(cabled2, { vlanId: 40, attach: [{ target: { kind: 'port', portId: a.portId, interfaceName: 'Et1' } }] }, { now: NOW });
    const withBoth = addVlan(withA, { vlanId: 40, attach: [{ target: { kind: 'port', portId: b.portId, interfaceName: 'Et1' } }] }, { now: NOW });
    const { vlanRows } = deriveNetworks(withBoth);
    expect(vlanRows).toHaveLength(1);
    expect(vlanRows[0].joined).toBe(true);
    const memberOnA = vlanRows[0].members.find((m) => m.deviceId === a.deviceId)!;
    expect(memberOnA.farDeviceId).toBe(b.deviceId);
    expect(memberOnA.viaPassiveHops).toBe(1);
  });
});

describe('deriveNetworks — subnet rows', () => {
  it('a subnet with no VLAN becomes a row, labelled interface · description', () => {
    const { doc, portIds } = deviceWithPorts(['wg0']);
    const withSubnet = addSubnet(
      doc,
      { prefix: '10.8.0.0/24', attach: [{ target: { kind: 'port', portId: portIds[0], interfaceName: 'wg0' }, address: '10.8.0.1/24', name: 'Road warriors' }] },
      { now: NOW },
    );
    const { subnetRows, vlanRows } = deriveNetworks(withSubnet);
    expect(vlanRows).toHaveLength(0);
    expect(subnetRows).toHaveLength(1);
    expect(subnetRows[0].prefix).toBe('10.8.0.0/24');
    expect(subnetRows[0].label).toBe('wg0 · Road warriors');
  });

  it('a gateway address does not also appear as a "subnet with no VLAN" row', () => {
    const { doc, portIds } = deviceWithPorts(['igc1']);
    const withVlan = addVlan(
      doc,
      {
        vlanId: 50,
        attach: [{ target: { kind: 'port', portId: portIds[0], interfaceName: 'igc1' }, gateway: true }],
        subnet: '10.0.50.0/24',
        gatewayAddress: '10.0.50.1/24',
      },
      { now: NOW },
    );
    const { subnetRows } = deriveNetworks(withVlan);
    expect(subnetRows).toHaveLength(0);
  });
});

describe('deriveNetworks — liveness, vlan_id fallback, and other edge cases', () => {
  it('a tagged unit with vlan_id V, no VlanMember edge, cabled to a trunk carrying V is a member', () => {
    const { doc, a, b } = twoDevices();
    const cabled = connectPorts(doc, a.portId, b.portId, {}, { now: NOW });
    // a.Et1 trunks vlan 10 for real (an explicit VlanMember); b.Et1 is a raw
    // fixture unit with LogicalUnit.vlan_id = 10 and no VlanMember edge at
    // all -- a real device's routed sub-interface shape.
    const withA = addVlan(cabled, { vlanId: 10, attach: [{ target: { kind: 'port', portId: a.portId, interfaceName: 'Et1' } }] }, { now: NOW });
    const bIfaceId = formatNodeId('Interface', newUlid(NOW));
    const bUnitId = formatNodeId('LogicalUnit', newUlid(NOW));
    const withRaw: Document = {
      ...withA,
      nodes: [
        ...withA.nodes,
        { id: bIfaceId, existence: newUlid(NOW), fields: { 'Interface.name': { presence: 'set', prov: newUlid(NOW), value: 'Et1' } } },
        {
          id: bUnitId,
          existence: newUlid(NOW),
          fields: {
            'LogicalUnit.index': { presence: 'set', prov: newUlid(NOW), value: 10 },
            'LogicalUnit.vlan_id': { presence: 'set', prov: newUlid(NOW), value: '10' },
          },
        },
      ],
      edges: [
        ...withA.edges,
        { id: formatEdgeId('HasInterface', newUlid(NOW)), from: b.deviceId, to: bIfaceId, prov: newUlid(NOW), fields: {} },
        { id: formatEdgeId('Occupies', newUlid(NOW)), from: bIfaceId, to: b.portId, prov: newUlid(NOW), fields: {} },
        { id: formatEdgeId('HasUnit', newUlid(NOW)), from: bIfaceId, to: bUnitId, prov: newUlid(NOW), fields: {} },
      ],
    };
    const { vlanRows } = deriveNetworks(withRaw);
    expect(vlanRows).toHaveLength(1);
    expect(vlanRows[0].joined).toBe(true);
    const implicitMember = vlanRows[0].members.find((m) => m.unitId === bUnitId);
    expect(implicitMember).toBeDefined();
    expect(implicitMember!.vlanMemberEdgeId).toBeUndefined();
  });

  it('a host cabled to the gateway\'s (trunk) port stays a "subnet with no VLAN" row: untagged meets access, not trunk', () => {
    const { doc, a, b } = twoDevices();
    const cabled = connectPorts(doc, a.portId, b.portId, {}, { now: NOW });
    const withGateway = addVlan(
      cabled,
      {
        vlanId: 10,
        attach: [{ target: { kind: 'port', portId: a.portId, interfaceName: 'Et1' }, gateway: true }],
        gatewayAddress: '10.0.10.1/24',
      },
      { now: NOW },
    );
    // b is cabled straight to the gateway's port -- a trunk (a gateway
    // is always tagged), never an access port, so b's untagged unit joins
    // no VLAN and keeps its address as a plain subnet row.
    const withHost = addSubnet(
      withGateway,
      { prefix: '10.0.10.0/24', attach: [{ target: { kind: 'port', portId: b.portId, interfaceName: 'Et1' }, address: '10.0.10.5/24' }] },
      { now: NOW },
    );
    const { subnetRows } = deriveNetworks(withHost);
    expect(subnetRows).toHaveLength(1);
    expect(subnetRows[0].members[0].address).toBe('10.0.10.5/24');
  });

  it('a tombstoned port breaks the cable join — the far side stops resolving, and the row splits', () => {
    const { doc, a, b } = twoDevices();
    const cabled = connectPorts(doc, a.portId, b.portId, {}, { now: NOW });
    const withA = addVlan(cabled, { vlanId: 10, attach: [{ target: { kind: 'port', portId: a.portId, interfaceName: 'Et1' } }] }, { now: NOW });
    const withBoth = addVlan(withA, { vlanId: 10, attach: [{ target: { kind: 'port', portId: b.portId, interfaceName: 'Et1' } }] }, { now: NOW });
    // Kill b's port by hand -- a removed port, not through any command this
    // module ships (there is no removePort command yet).
    const dead: Document = { ...withBoth, nodes: withBoth.nodes.map((n) => (n.id === b.portId ? { ...n, absentSince: NOW } : n)) };
    const { vlanRows } = deriveNetworks(dead);
    const rowsFor10 = vlanRows.filter((r) => r.vlanId === 10);
    expect(rowsFor10).toHaveLength(2);
    expect(rowsFor10.every((r) => r.joined === false)).toBe(true);
    const memberOnA = rowsFor10.flatMap((r) => r.members).find((m) => m.deviceId === a.deviceId)!;
    expect(memberOnA.farDeviceId).toBeUndefined();
  });

  it('a tombstoned device drops out of the row entirely', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    const withVlan = addVlan(doc, { vlanId: 10, on: [deviceId] }, { now: NOW });
    const dead: Document = { ...withVlan, nodes: withVlan.nodes.map((n) => (n.id === deviceId ? { ...n, absentSince: NOW } : n)) };
    expect(deriveNetworks(dead).vlanRows).toHaveLength(0);
  });

  it('the same VLAN id twice on one device is one VLAN there, not two "not joined" rows', () => {
    const { doc, portIds } = deviceWithPorts(['Et1', 'Et2']);
    const withFirst = addVlan(doc, { vlanId: 10, attach: [{ target: { kind: 'port', portId: portIds[0], interfaceName: 'Et1' } }] }, { now: NOW });
    // A second, independent Vlan node with the same numeric id on the SAME
    // device -- addVlan itself refuses this (device-already-has-vlan), so
    // this is a raw fixture standing in for a payload that predates that
    // refusal, or one the L0 declarations do not enforce.
    const secondVlanId = formatNodeId('Vlan', newUlid(NOW));
    const deviceId = withFirst.nodes.find((n) => parseNodeId(n.id).kind === 'Device')!.id;
    const withSecond: Document = {
      ...withFirst,
      nodes: [...withFirst.nodes, { id: secondVlanId, existence: newUlid(NOW), fields: { 'Vlan.vlan_id': { presence: 'set', prov: newUlid(NOW), value: '10' } } }],
      edges: [...withFirst.edges, { id: formatEdgeId('HasVlan', newUlid(NOW)), from: deviceId, to: secondVlanId, prov: newUlid(NOW), fields: {} }],
    };
    const { vlanRows } = deriveNetworks(withSecond);
    const rowsFor10 = vlanRows.filter((r) => r.vlanId === 10);
    expect(rowsFor10).toHaveLength(1);
    expect(rowsFor10[0].joined).toBe(true);
    expect(rowsFor10[0].vlanNodeIds).toHaveLength(2);
  });

  it('two unrelated same-prefix subnets, uncabled, are two rows; cabled, one', () => {
    const { doc, a, b } = twoDevices();
    const uncabled = addSubnet(
      addSubnet(doc, { prefix: '192.168.1.0/24', attach: [{ target: { kind: 'port', portId: a.portId, interfaceName: 'Et1' }, address: '192.168.1.1/24' }] }, { now: NOW }),
      { prefix: '192.168.1.0/24', attach: [{ target: { kind: 'port', portId: b.portId, interfaceName: 'Et1' }, address: '192.168.1.2/24' }] },
      { now: NOW },
    );
    expect(deriveNetworks(uncabled).subnetRows).toHaveLength(2);

    const cabled = connectPorts(doc, a.portId, b.portId, {}, { now: NOW });
    const oneSubnet = addSubnet(
      addSubnet(cabled, { prefix: '192.168.1.0/24', attach: [{ target: { kind: 'port', portId: a.portId, interfaceName: 'Et1' }, address: '192.168.1.1/24' }] }, { now: NOW }),
      { prefix: '192.168.1.0/24', attach: [{ target: { kind: 'port', portId: b.portId, interfaceName: 'Et1' }, address: '192.168.1.2/24' }] },
      { now: NOW },
    );
    const rows = deriveNetworks(oneSubnet).subnetRows;
    expect(rows).toHaveLength(1);
    expect(rows[0].members).toHaveLength(2);
  });

  it('an inet6 Address does not crash the derivation', () => {
    const { doc, portIds } = deviceWithPorts(['Et1']);
    const withVlan = addVlan(doc, { vlanId: 10, attach: [{ target: { kind: 'port', portId: portIds[0], interfaceName: 'Et1' } }] }, { now: NOW });
    const unitId = withVlan.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'LogicalUnit')!.id;
    const addrId = formatNodeId('Address', newUlid(NOW));
    const withV6: Document = {
      ...withVlan,
      nodes: [
        ...withVlan.nodes,
        { id: addrId, existence: newUlid(NOW), fields: { 'Address.value': { presence: 'set', prov: newUlid(NOW), value: 'fd00::1/64' }, 'Address.family': { presence: 'set', prov: newUlid(NOW), value: 'inet6' } } },
      ],
      edges: [...withVlan.edges, { id: formatEdgeId('HasAddress', newUlid(NOW)), from: unitId, to: addrId, prov: newUlid(NOW), fields: {} }],
    };
    expect(() => deriveNetworks(withV6)).not.toThrow();
    expect(deriveNetworks(withV6).subnetRows).toHaveLength(0);
  });
});

describe('cablesCarryingVlan', () => {
  it('returns the cable joining two devices carrying the same VLAN', () => {
    const { doc, a, b } = twoDevices();
    const before = new Set(doc.nodes.map((n) => n.id));
    const cabled = connectPorts(doc, a.portId, b.portId, {}, { now: NOW });
    const cableId = cabled.nodes.find((n) => !before.has(n.id) && parseNodeId(n.id).kind === 'Cable')!.id;
    const withA = addVlan(cabled, { vlanId: 10, attach: [{ target: { kind: 'port', portId: a.portId, interfaceName: 'Et1' } }] }, { now: NOW });
    const withBoth = addVlan(withA, { vlanId: 10, attach: [{ target: { kind: 'port', portId: b.portId, interfaceName: 'Et1' } }] }, { now: NOW });
    const row = deriveNetworks(withBoth).vlanRows[0];
    expect(cablesCarryingVlan(withBoth, row.vlanNodeIds)).toEqual([cableId]);
  });

  it('returns nothing for a VLAN id nothing carries', () => {
    const { doc, deviceId } = deviceWithPorts([]);
    const withVlan = addVlan(doc, { vlanId: 20, on: [deviceId] }, { now: NOW });
    const row = deriveNetworks(withVlan).vlanRows[0];
    expect(cablesCarryingVlan(withVlan, row.vlanNodeIds)).toEqual([]);
  });

  it('answers per joined row — two "not joined" rows never merge', () => {
    const { doc, a, b } = twoDevices();
    const withA = addVlan(doc, { vlanId: 30, attach: [{ target: { kind: 'port', portId: a.portId, interfaceName: 'Et1' } }] }, { now: NOW });
    const withBoth = addVlan(withA, { vlanId: 30, attach: [{ target: { kind: 'port', portId: b.portId, interfaceName: 'Et1' } }] }, { now: NOW });
    const rows = deriveNetworks(withBoth).vlanRows.filter((r) => r.vlanId === 30);
    expect(rows).toHaveLength(2);
    // Neither row has any cable at all (a and b are uncabled), but each
    // call is scoped to its row's vlanNodeIds, not the shared id.
    expect(cablesCarryingVlan(withBoth, rows[0].vlanNodeIds)).toEqual([]);
    expect(cablesCarryingVlan(withBoth, rows[1].vlanNodeIds)).toEqual([]);
  });
});

describe('deriveNetworks — one shared layer-2 model', () => {
  it('a pasted join, both sides inferred (no Occupies at all), still joins one row', () => {
    const { doc, a, b } = twoDevices();
    const cabled = connectPorts(doc, a.portId, b.portId, {}, { now: NOW });
    const withVlanA = addVlan(cabled, { vlanId: 60, on: [a.deviceId] }, { now: NOW });
    const vlanA = withVlanA.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Vlan')!.id;
    const withVlanB = addVlan(withVlanA, { vlanId: 60, on: [b.deviceId] }, { now: NOW });
    const vlanB = withVlanB.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Vlan' && n.id !== vlanA)!.id;

    // Raw fixture: a totally pasted Interface + LogicalUnit on EACH device,
    // no Occupies edge at all — only Interface.name = 'Et1' to match each
    // device's real port by label, the "endpoints" rule applied on BOTH
    // sides of the cable.
    function pastedAccessUnit(d: Document, deviceId: string, vlanNodeId: string): Document {
      const ifaceId = formatNodeId('Interface', newUlid(NOW));
      const unitId = formatNodeId('LogicalUnit', newUlid(NOW));
      return {
        ...d,
        nodes: [
          ...d.nodes,
          { id: ifaceId, existence: newUlid(NOW), fields: { 'Interface.name': { presence: 'set', prov: newUlid(NOW), value: 'Et1' } } },
          { id: unitId, existence: newUlid(NOW), fields: { 'LogicalUnit.index': { presence: 'set', prov: newUlid(NOW), value: 0 } } },
        ],
        edges: [
          ...d.edges,
          { id: formatEdgeId('HasInterface', newUlid(NOW)), from: deviceId, to: ifaceId, prov: newUlid(NOW), fields: {} },
          { id: formatEdgeId('HasUnit', newUlid(NOW)), from: ifaceId, to: unitId, prov: newUlid(NOW), fields: {} },
          {
            id: formatEdgeId('VlanMember', newUlid(NOW)),
            from: unitId,
            to: vlanNodeId,
            prov: newUlid(NOW),
            fields: { 'VlanMember.mode': { presence: 'set', prov: newUlid(NOW), value: 'access' } },
          },
        ],
      };
    }
    let withPasted = pastedAccessUnit(withVlanB, a.deviceId, vlanA);
    withPasted = pastedAccessUnit(withPasted, b.deviceId, vlanB);

    const { vlanRows } = deriveNetworks(withPasted);
    const rows60 = vlanRows.filter((r) => r.vlanId === 60);
    expect(rows60).toHaveLength(1);
    expect(rows60[0].joined).toBe(true);
    expect(rows60[0].members.length).toBeGreaterThanOrEqual(2);
    expect(rows60[0].members.every((m) => m.interfaceLabelIsFallback)).toBe(true);
  });

  it('two hosts behind one bare switch (blank bridge, no VLAN config) are one subnet row', () => {
    let sw = createSketchDevice(emptyDocument(), { now: NOW });
    const switchId = sw.nodes.find((n) => parseNodeId(n.id).kind === 'Device')!.id;
    sw = setDeviceField(sw, switchId, 'role', 'switch', { now: NOW });
    const chassisId = sw.nodes.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
    let before = new Set(sw.nodes.map((n) => n.id));
    sw = addSketchPort(sw, chassisId, { label: 'Et1', connector: 'rj45', face: 'front' }, { now: NOW });
    const swEt1 = sw.nodes.find((n) => !before.has(n.id) && parseNodeId(n.id).kind === 'PhysicalPort')!.id;
    before = new Set(sw.nodes.map((n) => n.id));
    sw = addSketchPort(sw, chassisId, { label: 'Et2', connector: 'rj45', face: 'front' }, { now: NOW });
    const swEt2 = sw.nodes.find((n) => !before.has(n.id) && parseNodeId(n.id).kind === 'PhysicalPort')!.id;

    const hostA = deviceWithPorts(['eth0']);
    const hostB = deviceWithPorts(['eth0']);
    let combined: Document = {
      ...emptyDocument(),
      nodes: [...sw.nodes, ...hostA.doc.nodes, ...hostB.doc.nodes],
      edges: [...sw.edges, ...hostA.doc.edges, ...hostB.doc.edges],
      provenance: [...sw.provenance, ...hostA.doc.provenance, ...hostB.doc.provenance],
      batches: [...sw.batches, ...hostA.doc.batches, ...hostB.doc.batches],
    };
    combined = connectPorts(combined, swEt1, hostA.portIds[0], {}, { now: NOW });
    combined = connectPorts(combined, swEt2, hostB.portIds[0], {}, { now: NOW });
    combined = addSubnet(
      combined,
      { prefix: '10.1.1.0/24', attach: [{ target: { kind: 'port', portId: hostA.portIds[0], interfaceName: 'eth0' }, address: '10.1.1.10/24' }] },
      { now: NOW },
    );
    combined = addSubnet(
      combined,
      { prefix: '10.1.1.0/24', attach: [{ target: { kind: 'port', portId: hostB.portIds[0], interfaceName: 'eth0' }, address: '10.1.1.11/24' }] },
      { now: NOW },
    );

    const { subnetRows } = deriveNetworks(combined);
    expect(subnetRows).toHaveLength(1);
    expect(subnetRows[0].members).toHaveLength(2);
  });

  it('a host on an access port joins the VLAN by connectivity, asserting nothing itself', () => {
    const { doc, a, b } = twoDevices();
    const roled = setDeviceField(doc, a.deviceId, 'role', 'switch', { now: NOW });
    const cabled = connectPorts(roled, a.portId, b.portId, {}, { now: NOW });
    const withVlan = addVlan(cabled, { vlanId: 70, attach: [{ target: { kind: 'port', portId: a.portId, interfaceName: 'Et1' } }] }, { now: NOW });
    const withHost = addSubnet(
      withVlan,
      { prefix: '10.2.2.0/24', attach: [{ target: { kind: 'port', portId: b.portId, interfaceName: 'Et1' }, address: '10.2.2.5/24' }] },
      { now: NOW },
    );
    const { vlanRows, subnetRows } = deriveNetworks(withHost);
    const row70 = vlanRows.find((r) => r.vlanId === 70)!;
    const hostMember = row70.members.find((m) => m.deviceId === b.deviceId);
    expect(hostMember).toBeDefined();
    expect(hostMember!.vlanMemberEdgeId).toBeUndefined();
    // The host's address is now a VLAN member's address, never listed again
    // as a "subnet with no VLAN" row.
    expect(subnetRows).toHaveLength(0);
  });

  it('an unrelated site\'s same-prefix address stays visible, never hidden by a VLAN\'s cidr', () => {
    const { doc, a, b } = twoDevices();
    const withGateway = addVlan(
      doc,
      {
        vlanId: 80,
        attach: [{ target: { kind: 'port', portId: a.portId, interfaceName: 'Et1' }, gateway: true }],
        gatewayAddress: '10.0.80.1/24',
        subnet: '10.0.80.0/24',
      },
      { now: NOW },
    );
    // b is never cabled to a, and asserts no VLAN membership -- only an
    // address that happens to share the VLAN's /24, exactly the
    // "unrelated site" a naive whole-design prefix match would wrongly
    // hide.
    const withHost = addSubnet(
      withGateway,
      { prefix: '10.0.80.0/24', attach: [{ target: { kind: 'port', portId: b.portId, interfaceName: 'Et1' }, address: '10.0.80.50/24' }] },
      { now: NOW },
    );
    const { subnetRows } = deriveNetworks(withHost);
    expect(subnetRows).toHaveLength(1);
    expect(subnetRows[0].members[0].address).toBe('10.0.80.50/24');
  });
});

describe('deriveNetworks — untagged flood, conflicts, and role hints', () => {
  it('an untagged host cabled to a trunk carrying 10 and 20 joins neither row, and keeps its subnet row', () => {
    const t = deviceWithPorts(['Et1']);
    const h = deviceWithPorts(['Et1']);
    let doc: Document = {
      ...emptyDocument(),
      nodes: [...t.doc.nodes, ...h.doc.nodes],
      edges: [...t.doc.edges, ...h.doc.edges],
      provenance: [...t.doc.provenance, ...h.doc.provenance],
      batches: [...t.doc.batches, ...h.doc.batches],
    };
    doc = connectPorts(doc, t.portIds[0], h.portIds[0], {}, { now: NOW });

    const set = (v: FieldEntry['value']): FieldEntry => ({ presence: 'set', prov: newUlid(NOW), value: v });
    const ifaceId = formatNodeId('Interface', newUlid(NOW));
    const unitId = formatNodeId('LogicalUnit', newUlid(NOW));
    const vlan10Id = formatNodeId('Vlan', newUlid(NOW));
    const vlan20Id = formatNodeId('Vlan', newUlid(NOW));
    doc = {
      ...doc,
      nodes: [
        ...doc.nodes,
        { id: ifaceId, existence: newUlid(NOW), fields: { 'Interface.name': set('Et1') } },
        { id: unitId, existence: newUlid(NOW), fields: { 'LogicalUnit.index': set(0) } },
        { id: vlan10Id, existence: newUlid(NOW), fields: { 'Vlan.vlan_id': set('10') } },
        { id: vlan20Id, existence: newUlid(NOW), fields: { 'Vlan.vlan_id': set('20') } },
      ],
      edges: [
        ...doc.edges,
        { id: formatEdgeId('HasInterface', newUlid(NOW)), from: t.deviceId, to: ifaceId, prov: newUlid(NOW), fields: {} },
        { id: formatEdgeId('Occupies', newUlid(NOW)), from: ifaceId, to: t.portIds[0], prov: newUlid(NOW), fields: {} },
        { id: formatEdgeId('HasUnit', newUlid(NOW)), from: ifaceId, to: unitId, prov: newUlid(NOW), fields: {} },
        { id: formatEdgeId('HasVlan', newUlid(NOW)), from: t.deviceId, to: vlan10Id, prov: newUlid(NOW), fields: {} },
        { id: formatEdgeId('HasVlan', newUlid(NOW)), from: t.deviceId, to: vlan20Id, prov: newUlid(NOW), fields: {} },
        { id: formatEdgeId('VlanMember', newUlid(NOW)), from: unitId, to: vlan10Id, prov: newUlid(NOW), fields: { 'VlanMember.mode': set('trunk') } },
        { id: formatEdgeId('VlanMember', newUlid(NOW)), from: unitId, to: vlan20Id, prov: newUlid(NOW), fields: { 'VlanMember.mode': set('trunk') } },
      ],
    };

    doc = addSubnet(doc, { prefix: '10.5.5.0/24', attach: [{ target: { kind: 'port', portId: h.portIds[0], interfaceName: 'Et1' }, address: '10.5.5.5/24' }] }, { now: NOW });

    const { vlanRows, subnetRows } = deriveNetworks(doc);
    const row10 = vlanRows.find((r) => r.vlanId === 10)!;
    const row20 = vlanRows.find((r) => r.vlanId === 20)!;
    expect(row10.members.some((m) => m.deviceId === h.deviceId)).toBe(false);
    expect(row20.members.some((m) => m.deviceId === h.deviceId)).toBe(false);
    expect(subnetRows).toHaveLength(1);
    expect(subnetRows[0].members[0].address).toBe('10.5.5.5/24');
  });

  it('two access VLANs meeting through a blank switch mark both rows with a conflict, never a silent join', () => {
    const a = deviceWithPorts(['Et1']);
    const b = deviceWithPorts(['Et1']);
    const s = deviceWithPorts(['Et1', 'Et2']);
    let doc: Document = {
      ...emptyDocument(),
      nodes: [...a.doc.nodes, ...b.doc.nodes, ...s.doc.nodes],
      edges: [...a.doc.edges, ...b.doc.edges, ...s.doc.edges],
      provenance: [...a.doc.provenance, ...b.doc.provenance, ...s.doc.provenance],
      batches: [...a.doc.batches, ...b.doc.batches, ...s.doc.batches],
    };
    doc = setDeviceField(doc, s.deviceId, 'role', 'switch', { now: NOW });
    doc = connectPorts(doc, a.portIds[0], s.portIds[0], {}, { now: NOW });
    doc = connectPorts(doc, s.portIds[1], b.portIds[0], {}, { now: NOW });
    doc = addVlan(doc, { vlanId: 10, attach: [{ target: { kind: 'port', portId: a.portIds[0], interfaceName: 'Et1' } }] }, { now: NOW });
    doc = addVlan(doc, { vlanId: 20, attach: [{ target: { kind: 'port', portId: b.portIds[0], interfaceName: 'Et1' } }] }, { now: NOW });

    const { vlanRows } = deriveNetworks(doc);
    const row10 = vlanRows.find((r) => r.vlanId === 10)!;
    const row20 = vlanRows.find((r) => r.vlanId === 20)!;
    expect(row10.conflicts.some((c) => c.otherVlanId === 20 && c.viaDeviceId === s.deviceId)).toBe(true);
    expect(row20.conflicts.some((c) => c.otherVlanId === 10 && c.viaDeviceId === s.deviceId)).toBe(true);
    expect(row10.members.some((m) => m.deviceId === b.deviceId)).toBe(false);
    expect(row20.members.some((m) => m.deviceId === a.deviceId)).toBe(false);
  });

  it('two hosts behind a hand-drawn switch with no role stay two subnet rows, with a hint naming the device', () => {
    const s = deviceWithPorts(['Et1', 'Et2']);
    const h1 = deviceWithPorts(['Et1']);
    const h2 = deviceWithPorts(['Et1']);
    let doc: Document = {
      ...emptyDocument(),
      nodes: [...s.doc.nodes, ...h1.doc.nodes, ...h2.doc.nodes],
      edges: [...s.doc.edges, ...h1.doc.edges, ...h2.doc.edges],
      provenance: [...s.doc.provenance, ...h1.doc.provenance, ...h2.doc.provenance],
      batches: [...s.doc.batches, ...h1.doc.batches, ...h2.doc.batches],
    };
    doc = connectPorts(doc, s.portIds[0], h1.portIds[0], {}, { now: NOW });
    doc = connectPorts(doc, s.portIds[1], h2.portIds[0], {}, { now: NOW });
    doc = addSubnet(doc, { prefix: '10.6.6.0/24', attach: [{ target: { kind: 'port', portId: h1.portIds[0], interfaceName: 'Et1' }, address: '10.6.6.1/24' }] }, { now: NOW });
    doc = addSubnet(doc, { prefix: '10.6.6.0/24', attach: [{ target: { kind: 'port', portId: h2.portIds[0], interfaceName: 'Et1' }, address: '10.6.6.2/24' }] }, { now: NOW });

    const { subnetRows } = deriveNetworks(doc);
    expect(subnetRows).toHaveLength(2);
    expect(subnetRows.every((r) => r.roleHintDeviceId === s.deviceId)).toBe(true);
  });
});

describe('deriveNetworks — performance', () => {
  /** A raw, bulk-built design: `numSwitches` access switches, each with
   * `portsPerSwitch` host-facing ports, each cabled to its bare host and
   * carrying its numeric VLAN id — no command layer, no per-node array
   * copy-and-append, so construction time measures nothing this test cares
   * about. 60 switches * 12 ports = 1,440 ports. */
  function syntheticSwitchedDesign(numSwitches: number, portsPerSwitch = 12): Document {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const set = (v: FieldEntry['value']): FieldEntry => ({ presence: 'set', prov: newUlid(NOW), value: v });

    for (let i = 0; i < numSwitches; i += 1) {
      const deviceId = formatNodeId('Device', newUlid(NOW));
      const chassisId = formatNodeId('Chassis', newUlid(NOW));
      nodes.push({ id: deviceId, existence: newUlid(NOW), fields: { 'Device.hostname': set(`sw-${i}`), 'Device.role': set('switch') } });
      nodes.push({ id: chassisId, existence: newUlid(NOW), fields: {} });
      edges.push({ id: formatEdgeId('HasChassis', newUlid(NOW)), from: deviceId, to: chassisId, prov: newUlid(NOW), fields: {} });

      const vlanId = formatNodeId('Vlan', newUlid(NOW));
      nodes.push({ id: vlanId, existence: newUlid(NOW), fields: { 'Vlan.vlan_id': set(String(100 + i)) } });
      edges.push({ id: formatEdgeId('HasVlan', newUlid(NOW)), from: deviceId, to: vlanId, prov: newUlid(NOW), fields: {} });

      for (let p = 0; p < portsPerSwitch; p += 1) {
        const portId = formatNodeId('PhysicalPort', newUlid(NOW));
        nodes.push({ id: portId, existence: newUlid(NOW), fields: { 'PhysicalPort.label': set(`Et${p}`), 'PhysicalPort.connector': set('rj45') } });
        edges.push({ id: formatEdgeId('HasPort', newUlid(NOW)), from: chassisId, to: portId, prov: newUlid(NOW), fields: {} });

        const ifaceId = formatNodeId('Interface', newUlid(NOW));
        const unitId = formatNodeId('LogicalUnit', newUlid(NOW));
        nodes.push({ id: ifaceId, existence: newUlid(NOW), fields: { 'Interface.name': set(`Et${p}`) } });
        nodes.push({ id: unitId, existence: newUlid(NOW), fields: { 'LogicalUnit.index': set(0) } });
        edges.push({ id: formatEdgeId('HasInterface', newUlid(NOW)), from: deviceId, to: ifaceId, prov: newUlid(NOW), fields: {} });
        edges.push({ id: formatEdgeId('Occupies', newUlid(NOW)), from: ifaceId, to: portId, prov: newUlid(NOW), fields: {} });
        edges.push({ id: formatEdgeId('HasUnit', newUlid(NOW)), from: ifaceId, to: unitId, prov: newUlid(NOW), fields: {} });
        edges.push({
          id: formatEdgeId('VlanMember', newUlid(NOW)),
          from: unitId,
          to: vlanId,
          prov: newUlid(NOW),
          fields: { 'VlanMember.mode': set('access') },
        });

        const hostDeviceId = formatNodeId('Device', newUlid(NOW));
        const hostChassisId = formatNodeId('Chassis', newUlid(NOW));
        const hostPortId = formatNodeId('PhysicalPort', newUlid(NOW));
        nodes.push({ id: hostDeviceId, existence: newUlid(NOW), fields: { 'Device.hostname': set(`sw-${i}-h${p}`) } });
        nodes.push({ id: hostChassisId, existence: newUlid(NOW), fields: {} });
        nodes.push({ id: hostPortId, existence: newUlid(NOW), fields: { 'PhysicalPort.label': set('Et0'), 'PhysicalPort.connector': set('rj45') } });
        edges.push({ id: formatEdgeId('HasChassis', newUlid(NOW)), from: hostDeviceId, to: hostChassisId, prov: newUlid(NOW), fields: {} });
        edges.push({ id: formatEdgeId('HasPort', newUlid(NOW)), from: hostChassisId, to: hostPortId, prov: newUlid(NOW), fields: {} });

        const cableId = formatNodeId('Cable', newUlid(NOW));
        nodes.push({ id: cableId, existence: newUlid(NOW), fields: {} });
        edges.push({ id: formatEdgeId('Terminates', newUlid(NOW)), from: cableId, to: portId, prov: newUlid(NOW), fields: {} });
        edges.push({ id: formatEdgeId('Terminates', newUlid(NOW)), from: cableId, to: hostPortId, prov: newUlid(NOW), fields: {} });
      }
    }
    return { ...emptyDocument(), nodes, edges, provenance: [], batches: [] };
  }

  it('derives 60 and 120 switches (1,440 and 2,880 ports) each in under 2 s, so a quadratic walk fails', () => {
    const doc60 = syntheticSwitchedDesign(60);
    const t60Start = performance.now();
    const result60 = deriveNetworks(doc60);
    const t60 = performance.now() - t60Start;

    const doc120 = syntheticSwitchedDesign(120);
    const t120Start = performance.now();
    const result120 = deriveNetworks(doc120);
    const t120 = performance.now() - t120Start;

    // eslint-disable-next-line no-console
    console.log(`deriveNetworks: 60 switches (1,440 ports) in ${t60.toFixed(1)} ms; 120 switches (2,880 ports) in ${t120.toFixed(1)} ms`);

    expect(result60.vlanRows).toHaveLength(60);
    expect(result120.vlanRows).toHaveLength(120);
    expect(t60).toBeLessThan(2000);
    expect(t120).toBeLessThan(2000);
  });
});
