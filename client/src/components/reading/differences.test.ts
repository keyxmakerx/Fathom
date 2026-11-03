import { describe, expect, it } from 'vitest';

import { applyEditorChange } from '../design/applyChange';
import { connectPorts } from '../../document/cables';
import { setDeviceField } from '../../document/edit';
import { asString, emptyDocument, fieldValue, findNode, type Document } from '../../document/model';
import { addBox, eth, tick } from '../troubleshoot/fixtures';
import { acceptAll, compare, portFor, shortName } from './differences';

const actor = { actor: '01ARZ3NDEKTSV4RRFFQ69G5FAV' };

function estate() {
  let doc: Document = emptyDocument();
  const a = addBox(doc, 'access-sw3', eth(48));
  doc = a.doc;
  const b = addBox(doc, 'dist-sw2', eth(4));
  doc = b.doc;
  doc = setDeviceField(doc, a.box.device, 'os_version', '17.9.4', tick());
  return { doc, sw3: a.box, sw2: b.box };
}

/** What a Catalyst says, in the shape the reader answers (helpers/reader/src/purposes.rs). */
function reading(over: Record<string, unknown> = {}) {
  return {
    system: { name: 'access-sw3.example.net', descr: 'Cisco IOS XE' },
    inventory: [
      { index: 1, class: 3, containedIn: 0, serial: 'JAE24410ABC', softwareRev: '17.12.3', modelName: 'C9200L-48P-4G' },
      { index: 1000, class: 9, containedIn: 1, serial: 'PSU123', softwareRev: '' },
    ],
    interfaces: [
      { index: 48, name: 'Gi1/0/48', descr: 'GigabitEthernet1/0/48', type: 6, operStatus: 1 },
      { index: 7, name: 'Gi1/0/7', descr: 'GigabitEthernet1/0/7', type: 6, operStatus: 2 },
      { index: 100, name: 'Vl20', type: 53, operStatus: 1 },
    ],
    lldp: {
      local: [{ portNum: 48, portId: 'Gi1/0/48', portDesc: 'GigabitEthernet1/0/48' }],
      remote: [{ localPortNum: 48, index: 1, sysName: 'dist-sw2.example.net', portId: 'Te1/1/3', portDesc: 'TenGigabitEthernet1/1/3', capEnabled: ['bridge'] }],
    },
    ...over,
  };
}

describe('device reading: what differs from the drawing', () => {
  it('finds the name, serial, firmware and a missing cable, and matches the name on its short form', () => {
    const { doc, sw3, sw2 } = estate();
    const c = compare(doc, sw3.device, reading(), []);
    expect(c.matches).toEqual(['name']);
    expect(c.differs.map((d) => [d.field, d.read, d.drawn, d.accept?.label])).toEqual([
      ['serial', 'JAE24410ABC', null, 'Add'],
      ['os_version', '17.12.3', '17.9.4', 'Accept'],
      ['lldp:Gi1/0/48', 'dist-sw2 · Te1/1/3', 'nothing connected', 'Add cable'],
    ]);
    expect(c.differs[2]!.accept!.change).toEqual({ kind: 'cable-connect', fromPortId: sw3.port('48'), toPortId: sw2.port('3') });
    // Ethernet only: the VLAN interface is not a port.
    expect([c.up, c.down]).toEqual([1, 1]);
  });

  it('keeps a dismissed difference away until the device says something else', () => {
    const { doc, sw3 } = estate();
    const dismissed = [{ field: 'os_version', value: '17.12.3' }];
    expect(compare(doc, sw3.device, reading(), dismissed).differs.map((d) => d.field)).not.toContain('os_version');
    const newer = reading({ inventory: [{ index: 1, class: 3, containedIn: 0, serial: 'JAE24410ABC', softwareRev: '17.15.1' }] });
    expect(compare(doc, sw3.device, newer, dismissed).differs.find((d) => d.field === 'os_version')?.read).toBe('17.15.1');
  });

  it('accepts all as one undo step, and then nothing differs', () => {
    const { doc, sw3 } = estate();
    const all = acceptAll(compare(doc, sw3.device, reading(), []).differs)!;
    const next = applyEditorChange(doc, all, [], actor).doc;
    expect(next.batches.length).toBe(doc.batches.length + 1);
    expect(asString(fieldValue(findNode(next, sw3.device)!.fields, 'Device.os_version'))).toBe('17.12.3');
    const again = compare(next, sw3.device, reading(), []);
    expect(again.differs).toEqual([]);
    expect(again.matches).toEqual(['name', 'serial', 'firmware', '1 neighbour']);
  });

  it('offers no cable when one is drawn elsewhere, or the neighbour is not in the design', () => {
    const { doc, sw3, sw2 } = estate();
    const cabled = connectPorts(doc, sw3.port('48'), sw2.port('1'), {}, tick());
    const d = compare(cabled, sw3.device, reading(), []).differs.find((x) => x.field.startsWith('lldp:'))!;
    expect(d.drawn).toBe('dist-sw2 · 1');
    expect(d.accept).toBeNull();
    const elsewhere = reading({ lldp: { local: [], remote: [{ localPortNum: 48, sysName: 'core-rtr1', portId: 'xe-0/0/1' }] } });
    const e = compare(doc, sw3.device, elsewhere, []).differs.find((x) => x.field.startsWith('lldp:'))!;
    expect(e.why).toBe("LLDP · core-rtr1 isn't in this design");
    expect(e.accept).toBeNull();
  });

  it('never offers a value the redaction gate withheld, or binary text', () => {
    const { doc, sw3 } = estate();
    const r = reading({ system: { name: '[withheld: it looked like a password]' }, inventory: [{ index: 1, class: 3, containedIn: 0, serial: 'hex:00ff', softwareRev: '17.9.4' }] });
    const c = compare(doc, sw3.device, r, []);
    expect(c.differs.filter((d) => !d.field.startsWith('lldp:'))).toEqual([]);
    expect(c.matches).toContain('firmware');
  });

  it('matches a port by its label, else by the last number when only one port has it', () => {
    const ports = [
      { id: 'a', label: '1', cabled: false, farPortId: null },
      { id: 'b', label: 'eth0', cabled: false, farPortId: null },
      { id: 'c', label: 'mgmt1', cabled: false, farPortId: null },
    ];
    expect(portFor(ports, ['eth0'])?.id).toBe('b');
    expect(portFor(ports, ['GigabitEthernet1/0/1'])?.id).toBe('a');
    expect(portFor([...ports, { id: 'd', label: '01', cabled: false, farPortId: null }], ['Gi1/0/1'])).toBeNull();
    expect(shortName('sw.example.net')).toBe('sw');
    expect(shortName('10.0.0.1')).toBe('10.0.0.1');
  });
});
