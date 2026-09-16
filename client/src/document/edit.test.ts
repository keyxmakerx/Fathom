import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../api/catalogue';
import { createRack, placeChassis, UnknownReferenceError } from './commands';
import { DEVICE_ROLES, FieldValueError, isIpAddr, setChassisField, setDeviceField, setRackField } from './edit';
import { edgesIn, emptyDocument, findNode, formatNodeId, readRackFields, type Document } from './model';
import { newUlid } from './ulid';

const NOW = 1_700_000_000_000;

const MODEL_1U: CatalogueModel = {
  vendor: 'juniper',
  model: 'EX4300-48P',
  rackUnits: 1,
  reviewedBy: 'reviewer',
  source: { cite: 'cite', readOn: '2026-09-14' },
  psuSlots: [
    { name: 'PSU0', hotSwap: true, face: 'rear', position: { row: 'single', column: 0 } },
    { name: 'PSU1', hotSwap: true, face: 'rear', position: { row: 'single', column: 1 } },
  ],
  faceplates: [{ face: 'front', portCount: 1, ports: [{ kind: 'RJ45', number: 0, uplink: false, row: 'single', column: 0, groupGapBefore: false }] }],
};

function docWithChassis(): { doc: Document; deviceId: string; chassisId: string } {
  const premisesId = formatNodeId('Premises', newUlid(NOW));
  const doc: Document = {
    ...emptyDocument(),
    nodes: [
      {
        id: premisesId,
        existence: newUlid(NOW),
        fields: { 'Premises.label': { presence: 'set', prov: newUlid(NOW), value: 'Riverside CO' } },
      },
    ],
  };
  const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', now: NOW });
  const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
  const placed = placeChassis(withRack, rackId, MODEL_1U, 12, 'front', { now: NOW });
  const mounted = edgesIn(placed, rackId, 'MountedIn')[0];
  const chassisId = mounted.from;
  const hasChassis = edgesIn(placed, chassisId, 'HasChassis')[0];
  return { doc: placed, deviceId: hasChassis.from, chassisId };
}

describe('setDeviceField — hostname', () => {
  it('sets Device.hostname as one Origin::Hand batch', () => {
    const { doc, deviceId } = docWithChassis();
    const next = setDeviceField(doc, deviceId, 'hostname', 'core-01', { now: NOW });
    const node = findNode(next, deviceId)!;
    expect(node.fields['Device.hostname']).toMatchObject({ presence: 'set', value: 'core-01' });
    const prov = next.provenance.find((p) => p.id === node.fields['Device.hostname'].prov)!;
    expect(prov.origin).toEqual({ kind: 'hand' });
    expect(next.batches.at(-1)!.ops).toEqual([
      { type: 'set_field', element: deviceId, key: 'Device.hostname', presence: 'set', prov: prov.id },
    ]);
  });

  it('does not mutate its input', () => {
    const { doc, deviceId } = docWithChassis();
    const before = JSON.stringify(doc);
    setDeviceField(doc, deviceId, 'hostname', 'core-01', { now: NOW });
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('supersedes a previous value on the second write', () => {
    const { doc, deviceId } = docWithChassis();
    const once = setDeviceField(doc, deviceId, 'hostname', 'core-01', { now: NOW });
    const firstProv = findNode(once, deviceId)!.fields['Device.hostname'].prov;
    const twice = setDeviceField(once, deviceId, 'hostname', 'core-02', { now: NOW + 1 });
    const node = findNode(twice, deviceId)!;
    expect(node.fields['Device.hostname'].value).toBe('core-02');
    const secondProv = twice.provenance.find((p) => p.id === node.fields['Device.hostname'].prov)!;
    expect(secondProv.supersedes).toBe(firstProv);
  });

  it('clears the field as absent, never an empty string', () => {
    const { doc, deviceId } = docWithChassis();
    const once = setDeviceField(doc, deviceId, 'hostname', 'core-01', { now: NOW });
    const cleared = setDeviceField(once, deviceId, 'hostname', null, { now: NOW + 1 });
    const entry = findNode(cleared, deviceId)!.fields['Device.hostname'];
    expect(entry.presence).toBe('absent');
    expect(entry.value).toBeUndefined();
  });

  it('refuses a hostname with a space (not a valid Identifier)', () => {
    const { doc, deviceId } = docWithChassis();
    expect(() => setDeviceField(doc, deviceId, 'hostname', 'core 01', { now: NOW })).toThrow(FieldValueError);
  });

  it('refuses an unknown device', () => {
    const { doc } = docWithChassis();
    expect(() =>
      setDeviceField(doc, 'device:01ARZ3NDEKTSV4RRFFQ69G5FAV', 'hostname', 'core-01', { now: NOW }),
    ).toThrow(UnknownReferenceError);
  });
});

describe('setDeviceField — role', () => {
  it('accepts every schema enum token', () => {
    const { doc, deviceId } = docWithChassis();
    for (const role of DEVICE_ROLES) {
      const next = setDeviceField(doc, deviceId, 'role', role, { now: NOW });
      expect(findNode(next, deviceId)!.fields['Device.role']).toMatchObject({ presence: 'set', value: role });
    }
  });

  it('refuses a value outside the enum', () => {
    const { doc, deviceId } = docWithChassis();
    expect(() => setDeviceField(doc, deviceId, 'role', 'router-ish', { now: NOW })).toThrow(FieldValueError);
  });
});

describe('setDeviceField — management_address', () => {
  it('accepts an IPv4 and an IPv6 literal', () => {
    const { doc, deviceId } = docWithChassis();
    const v4 = setDeviceField(doc, deviceId, 'management_address', '10.10.0.2', { now: NOW });
    expect(findNode(v4, deviceId)!.fields['Device.management_address']).toMatchObject({ value: '10.10.0.2' });
    const v6 = setDeviceField(doc, deviceId, 'management_address', 'fe80::1', { now: NOW });
    expect(findNode(v6, deviceId)!.fields['Device.management_address']).toMatchObject({ value: 'fe80::1' });
  });

  it('refuses a malformed address', () => {
    const { doc, deviceId } = docWithChassis();
    expect(() => setDeviceField(doc, deviceId, 'management_address', '10.10.0.999', { now: NOW })).toThrow(
      FieldValueError,
    );
    expect(() => setDeviceField(doc, deviceId, 'management_address', 'not-an-address', { now: NOW })).toThrow(
      FieldValueError,
    );
  });

  it('isIpAddr agrees with the field refusal', () => {
    expect(isIpAddr('192.168.1.1')).toBe(true);
    expect(isIpAddr('2001:db8::1')).toBe(true);
    expect(isIpAddr('256.1.1.1')).toBe(false);
    expect(isIpAddr('')).toBe(false);
  });
});

describe('setChassisField — serial', () => {
  it('sets Chassis.serial as one Origin::Hand batch', () => {
    const { doc, chassisId } = docWithChassis();
    const next = setChassisField(doc, chassisId, 'serial', 'SN-0042', { now: NOW });
    expect(findNode(next, chassisId)!.fields['Chassis.serial']).toMatchObject({ presence: 'set', value: 'SN-0042' });
  });

  it('clears as absent', () => {
    const { doc, chassisId } = docWithChassis();
    const once = setChassisField(doc, chassisId, 'serial', 'SN-0042', { now: NOW });
    const cleared = setChassisField(once, chassisId, 'serial', null, { now: NOW + 1 });
    expect(findNode(cleared, chassisId)!.fields['Chassis.serial'].presence).toBe('absent');
  });

  it('refuses an unknown chassis', () => {
    const { doc } = docWithChassis();
    expect(() =>
      setChassisField(doc, 'chassis:01ARZ3NDEKTSV4RRFFQ69G5FAV', 'serial', 'SN-1', { now: NOW }),
    ).toThrow(UnknownReferenceError);
  });
});

function docWithRack(): { doc: Document; rackId: string } {
  const premisesId = formatNodeId('Premises', newUlid(NOW));
  const doc: Document = {
    ...emptyDocument(),
    nodes: [
      {
        id: premisesId,
        existence: newUlid(NOW),
        fields: { 'Premises.label': { presence: 'set', prov: newUlid(NOW), value: 'Riverside CO' } },
      },
    ],
  };
  const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', now: NOW });
  const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
  return { doc: withRack, rackId };
}

describe('setRackField — row', () => {
  it('sets Rack.row as one Origin::Hand batch', () => {
    const { doc, rackId } = docWithRack();
    const next = setRackField(doc, rackId, 'row', 'Row A', { now: NOW });
    expect(readRackFields(findNode(next, rackId)!).row).toBe('Row A');
  });

  it('clears as absent', () => {
    const { doc, rackId } = docWithRack();
    const once = setRackField(doc, rackId, 'row', 'Row A', { now: NOW });
    const cleared = setRackField(once, rackId, 'row', null, { now: NOW + 1 });
    expect(findNode(cleared, rackId)!.fields['Rack.row'].presence).toBe('absent');
  });

  it('refuses an unknown rack', () => {
    const { doc } = docWithRack();
    expect(() => setRackField(doc, 'rack:01ARZ3NDEKTSV4RRFFQ69G5FAV', 'row', 'Row A', { now: NOW })).toThrow(
      UnknownReferenceError,
    );
  });
});

describe('setRackField — bay', () => {
  it('sets Rack.bay', () => {
    const { doc, rackId } = docWithRack();
    const next = setRackField(doc, rackId, 'bay', 3, { now: NOW });
    expect(readRackFields(findNode(next, rackId)!).bay).toBe(3);
  });

  it('refuses a bay below 1 (ADR-0050 §2: bays count from 1)', () => {
    const { doc, rackId } = docWithRack();
    expect(() => setRackField(doc, rackId, 'bay', 0, { now: NOW })).toThrow(FieldValueError);
    expect(() => setRackField(doc, rackId, 'bay', -1, { now: NOW })).toThrow(FieldValueError);
  });

  it('refuses a non-integer', () => {
    const { doc, rackId } = docWithRack();
    expect(() => setRackField(doc, rackId, 'bay', 1.5, { now: NOW })).toThrow(FieldValueError);
  });

  it('clears as absent', () => {
    const { doc, rackId } = docWithRack();
    const once = setRackField(doc, rackId, 'bay', 3, { now: NOW });
    const cleared = setRackField(once, rackId, 'bay', null, { now: NOW + 1 });
    expect(findNode(cleared, rackId)!.fields['Rack.bay'].presence).toBe('absent');
  });
});
