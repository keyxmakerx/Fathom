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
    expect(readFacts(INVENTORY)).toMatchObject({ vendor: 'cisco', model: 'N3K-C3548P-10GX', serial: 'FOC1847R05N' });
    expect(readFacts(INVENTORY)!.parts).toEqual([
      { kind: 'supply', slot: '1', name: 'Power Supply 1', model: 'N2200-PAC-400W', serial: 'LIT18300ABC', description: 'Nexus3500 PSU' },
    ]);
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

// r35: the parts in `show chassis hardware` and `show inventory`, in the shapes cited in facts.ts.
describe('parts the device reports', () => {
  const MX_HW = `Hardware inventory:
Item             Version  Part number  Serial number     Description
Chassis                                JN11F0A5BAFA      MX480
PEM 0            Rev 02   740-063046   QCS2207U0AJ       PS 1.4-2.52kW; 90-264V AC in
FPC 0            REV 60   750-070395   EAAT9462          MPC10E 3D MRATE-15xQSFPP
  CPU            REV 12   750-057177   EAAN6064          SMPC PMB
  PIC 0                   BUILTIN      BUILTIN           MRATE-5xQSFPP
    Xcvr 4       REV 01   740-157132   2E1CZFA728016     QSFP56-DD-400G-ZR
  PIC 1                   BUILTIN      BUILTIN           MRATE-5xQSFPP
`;

  const C9200_INV = `NAME: "c92xx Stack", DESCR: "c92xx Stack"
PID: C9200-48P         , VID: V01  , SN: JAE24111ABC

NAME: "Switch 2 - Power Supply A", DESCR: "Switch 2 - Power Supply A"
PID: PWR-C6-1KWAC      , VID: V01  , SN: ART2534F66H

NAME: "Switch 2 FRU Uplink Module 1", DESCR: "4x10G Uplink Module"
PID: C9200-NM-4X       , VID: V02  , SN: JAE25301H0D

NAME: "Te2/1/1", DESCR: "SFP-10GBase-SR"
PID: SFP-10G-SR        , VID: V03  , SN: ACW25481G46

NAME: "Te2/1/2", DESCR: "1000BaseSX SFP"
PID:                   , VID:      , SN: OSSX06400
`;

  it('reads cards, optics and supplies from show chassis hardware', () => {
    const facts = readFacts(MX_HW)!;
    expect(facts.model).toBe('MX480');
    expect(facts.parts!.map((p) => [p.kind, p.path ?? p.port ?? p.slot, p.model, p.serial])).toEqual([
      ['supply', '0', '740-063046', 'QCS2207U0AJ'],
      ['card', ['0'], '750-070395', 'EAAT9462'],
      ['optic', '0/0/4', '740-157132', '2E1CZFA728016'],
    ]);
  });

  it('reads cards, optics and supplies from show inventory, an empty PID included, and keeps the chassis model', () => {
    const facts = readFacts(C9200_INV)!;
    expect(facts.model).toBe('C9200-48P');
    expect(facts.serial).toBe('JAE24111ABC');
    expect(facts.parts!.map((p) => [p.kind, p.path ?? p.port ?? p.slot, p.model, p.serial])).toEqual([
      ['supply', 'A', 'PWR-C6-1KWAC', 'ART2534F66H'],
      ['card', ['1'], 'C9200-NM-4X', 'JAE25301H0D'],
      ['optic', '2/1/1', 'SFP-10G-SR', 'ACW25481G46'],
      ['optic', '2/1/2', undefined, 'OSSX06400'],
    ]);
  });

  it('offers an optic for an empty cage ticked, a card not drawn unticked, and writes them as one undo', async () => {
    const { addSketchPort } = await import('./commands');
    const { cardsOf, opticOf } = await import('./cards');
    const { doc: d0, chassisId } = device('sw2');
    let doc = d0;
    for (const label of ['Te2/1/1', 'Te2/1/2']) doc = addSketchPort(doc, chassisId, { label, connector: 'sfp_plus', face: 'front' }, OPTS);
    const facts = readFacts(C9200_INV)!;
    const rows = suggestFacts(doc, chassisId, facts);
    const parts = rows.filter((r) => r.part);
    expect(parts.map((r) => [r.label, r.state])).toEqual([
      ['Power supply A', 'note'],
      ['Card in slot 1', 'differs'],
      ['Optic in Te2/1/1', 'fill'],
      ['Optic in Te2/1/2', 'fill'],
    ]);
    const keys = new Set(parts.filter((r) => r.state !== 'note').map((r) => r.key));
    const next = acceptFacts(doc, chassisId, facts, keys, OPTS);
    expect(next.batches.length).toBe(doc.batches.length + 1);
    expect(cardsOf(next, chassisId)[0]).toMatchObject({ slot: '1', model: 'C9200-NM-4X', serial: 'JAE25301H0D' });
    const port = (label: string) => next.nodes.find((n) => parseNodeId(n.id).kind === 'PhysicalPort' && n.fields['PhysicalPort.label']?.value === label)!;
    expect(opticOf(port('Te2/1/1'))).toEqual({ type: 'SFP-10GBase-SR', part: 'SFP-10G-SR', serial: 'ACW25481G46' });
    expect(opticOf(port('Te2/1/2'))).toEqual({ type: '1000BaseSX SFP', serial: 'OSSX06400' });
    // Read again: everything now matches.
    expect(suggestFacts(next, chassisId, facts).filter((r) => r.part && r.state !== 'note').map((r) => r.state)).toEqual(['same', 'same', 'same']);
  });
});
