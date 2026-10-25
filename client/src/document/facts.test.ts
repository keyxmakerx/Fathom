import { describe, expect, it } from 'vitest';

import { createSketchDevice } from './commands';
import { setChassisField, setDeviceField } from './edit';
import { acceptFacts, looksLikeFacts, readFacts, suggestFacts } from './facts';
import { asString, emptyDocument, fieldValue, findNode, parseNodeId, readChassisFields, type Document } from './model';
import { undo } from './undo';

const OPTS = { now: 1_700_000_000_000, actor: 'test' };

function device(hostname: string): { doc: Document; deviceId: string; chassisId: string } {
  const doc = createSketchDevice(emptyDocument(), { ...OPTS, hostname });
  return {
    doc,
    deviceId: doc.nodes.find((n) => parseNodeId(n.id).kind === 'Device')!.id,
    chassisId: doc.nodes.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id,
  };
}

// The shapes of the samples cited in facts.ts, with this test's own values.
const JUNOS_NEW = `Hostname: sw-core
Model: ex4300-48p
Junos: 21.4R3-S5
JUNOS OS Kernel 64-bit  [20230525.0a7d3f2_builder_stable_12_214]
`;

const JUNOS_OLD = `Hostname: router1
Model: m20
JUNOS Base OS boot [7.2-20050312.0]
JUNOS Base OS Software Suite [7.2-20050312.0]
`;

const JUNOS_HW = `Hardware inventory:
Item             Version  Part number  Serial number     Description
Chassis                                ZF4320340016      EX4400-48MP
Routing Engine 0          BUILTIN      BUILTIN           RE-EX4400-48MP
`;

const IOS = `Cisco IOS Software [Bengaluru], Catalyst L3 Switch Software (CAT9K_IOSXE), Version 17.6.4, RELEASE SOFTWARE (fc1)
Technical Support: http://www.cisco.com/techsupport
Processor board ID FJC2325E0HB
Motherboard Serial Number          : FJZ23210BTF
System Serial Number               : FJC2325E0HB
`;

const IOS_OLD = 'Cisco IOS (tm) C3750 Software (C3750-I5-M), Version 12.1(14)EA1, RELEASE SOFTWARE (fc1)\nSystem serial number : CAT0726R0ZU\n';

const INVENTORY = `NAME: "Chassis",  DESCR: "Nexus3500 C3548P-10GX Chassis"
PID: N3K-C3548P-10GX     ,  VID: V00 ,  SN: FOC1847R05N

NAME: "Power Supply 1",  DESCR: "Nexus3500 PSU"
PID: N2200-PAC-400W      ,  VID: V02 ,  SN: LIT18300ABC
`;

const ARISTA = `Arista DCS-7050SX3-48YC8
Hardware version:    21.05
Serial number:       SSJ17290598
System MAC address:  2899.3abe.9f92

Software image version: 4.28.3M
`;

describe('reading what a device says about itself', () => {
  it('reads Junos show version, new and old', () => {
    expect(readFacts(JUNOS_NEW)).toEqual({ vendor: 'junos', hostname: 'sw-core', model: 'ex4300-48p', version: '21.4R3-S5' });
    expect(readFacts(JUNOS_OLD)).toEqual({ vendor: 'junos', hostname: 'router1', model: 'm20', version: '7.2-20050312.0' });
  });

  it('reads Junos show chassis hardware for the serial and model', () => {
    expect(readFacts(JUNOS_HW)).toEqual({ vendor: 'junos', model: 'EX4400-48MP', serial: 'ZF4320340016' });
  });

  it('reads Cisco show version, new and old', () => {
    expect(readFacts(IOS)).toEqual({ vendor: 'cisco', version: '17.6.4', serial: 'FJC2325E0HB' });
    expect(readFacts(IOS_OLD)).toEqual({ vendor: 'cisco', version: '12.1(14)EA1', serial: 'CAT0726R0ZU' });
  });

  it('reads the chassis entry of Cisco show inventory', () => {
    expect(readFacts(INVENTORY)).toEqual({ vendor: 'cisco', model: 'N3K-C3548P-10GX', serial: 'FOC1847R05N' });
  });

  it('reads Arista show version', () => {
    expect(readFacts(ARISTA)).toEqual({ vendor: 'arista', model: 'DCS-7050SX3-48YC8', serial: 'SSJ17290598', version: '4.28.3M' });
  });

  it('is not fooled by configs', () => {
    expect(looksLikeFacts('set system host-name sw1\nset version 21.4R3\n')).toBe(false);
    expect(looksLikeFacts('version 17.6\nhostname sw1\n!\ninterface Gi1/0/1\n description Model: uplink\n')).toBe(false);
  });
});

describe('offering them to a drawn device', () => {
  it('fills what the drawing lacks, ticked, and says the model', () => {
    const d = device('sw-core');
    const rows = suggestFacts(d.doc, d.chassisId, readFacts(ARISTA)!);
    expect(rows.map((r) => `${r.key}:${r.state}`)).toEqual(['serial:fill', 'version:fill', 'model:note']);
    expect(rows[2]!.why).toContain('DCS-7050SX3-48YC8');
  });

  it('offers a difference unticked and says the drawing has its own', () => {
    let d = device('sw-core');
    const doc = setChassisField(d.doc, d.chassisId, 'serial', 'OLD123', OPTS);
    d = { ...d, doc };
    const rows = suggestFacts(d.doc, d.deviceId, readFacts(IOS)!);
    expect(rows.find((r) => r.key === 'serial')).toMatchObject({ state: 'differs', ours: 'OLD123', theirs: 'FJC2325E0HB' });
  });

  it('notes a hostname that is not the drawing\'s', () => {
    const d = device('core-1');
    const r = suggestFacts(d.doc, d.deviceId, readFacts(JUNOS_NEW)!).find((s) => s.key === 'hostname')!;
    expect(r.state).toBe('note');
    expect(r.why).toContain('calls itself sw-core');
  });

  it('writes only the ticked serial and version, as one undo step', () => {
    const d = device('sw-core');
    const facts = readFacts(ARISTA)!;
    const next = acceptFacts(d.doc, d.deviceId, facts, new Set(['serial', 'version', 'model']), OPTS);
    expect(next.batches.length).toBe(d.doc.batches.length + 1);
    expect(next.batches.at(-1)!.label).toBe('facts from the device');
    expect(readChassisFields(findNode(next, d.chassisId)!)).toEqual({ model: undefined, serial: 'SSJ17290598' });
    expect(asString(fieldValue(findNode(next, d.deviceId)!.fields, 'Device.os_version'))).toBe('4.28.3M');
    const back = undo(next, next.batches.at(-1)!.id, OPTS);
    expect(asString(fieldValue(findNode(back, d.deviceId)!.fields, 'Device.os_version'))).toBeUndefined();
  });

  it('writes nothing when nothing is ticked', () => {
    const d = device('sw-core');
    expect(acceptFacts(d.doc, d.deviceId, readFacts(ARISTA)!, new Set(), OPTS)).toBe(d.doc);
  });

  it('refuses a version with spaces in it', () => {
    const d = device('sw-core');
    expect(() => setDeviceField(d.doc, d.deviceId, 'os_version', '4.28 3M', OPTS)).toThrow();
  });
});
