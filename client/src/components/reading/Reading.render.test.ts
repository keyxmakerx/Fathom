import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import type { DeviceReading, ReadingPanel } from '../../api/deviceRead';
import type { VaultEntry } from '../../api/vault';
import { setDeviceField } from '../../document/edit';
import { createIssue } from '../../document/issues';
import { edgesOut, emptyDocument, type Document } from '../../document/model';
import { TYPED_AS_WRITTEN, addStep, createPlan, startPlan } from '../../document/plans';
import { addBox, eth, tick } from '../troubleshoot/fixtures';
import { ReadLine, ReadNow, ReadingChip, ReadingsTab, usableLogins, when, whyOff } from './Reading';
import { ReadingContext, resetReadingStore, seedReading, type ReadingPlace } from './store';

const ORG = 'org1';
const DESIGN = 'design1';
const on: DeviceReading = { server: true, reader: true, on: true, usable: true, ranges: [{ cidr: '10.20.0.0/24', snmpPort: 161, sshPort: 22, login: null }], setBy: null, setAt: null };

function estate(): { doc: Document; device: string } {
  let doc = emptyDocument();
  const a = addBox(doc, 'access-sw3', eth(48));
  doc = a.doc;
  doc = addBox(doc, 'dist-sw2', eth(4)).doc;
  doc = setDeviceField(doc, a.box.device, 'management_address', '10.20.0.14', tick());
  doc = setDeviceField(doc, a.box.device, 'os_version', '17.9.4', tick());
  return { doc, device: a.box.device };
}

const reading = {
  system: { name: 'access-sw3' },
  inventory: [{ index: 1, class: 3, containedIn: 0, serial: 'JAE24410ABC', softwareRev: '17.12.3' }],
  interfaces: [{ index: 48, name: 'Gi1/0/48', type: 6, operStatus: 1 }],
  lldp: { local: [{ portNum: 48, portId: 'Gi1/0/48' }], remote: [{ localPortNum: 48, sysName: 'dist-sw2', portId: 'Te1/1/3' }] },
};

function chassisOf(doc: Document, device: string): string {
  return edgesOut(doc, device, 'HasChassis')[0]!.to;
}

function panel(over: Partial<ReadingPanel> = {}): ReadingPanel {
  return {
    readings: [
      { id: 'r2', readBy: 'a', readByName: 'Key Maker', readAt: Date.now(), durationMs: 4200, incomplete: [], failed: [], macLeftOut: null, withheld: 0, reading },
      { id: 'r1', readBy: 'b', readByName: 'Sam Ortiz', readAt: 1_790_000_000_000, durationMs: 3000, incomplete: [], failed: [], macLeftOut: null, withheld: 0, reading: null },
    ],
    macArp: null,
    macArpChanges: null,
    dismissed: [],
    ...over,
  };
}

function render(place: ReadingPlace, node: ReactNode): string {
  return renderToStaticMarkup(createElement(ReadingContext.Provider, { value: place }, node));
}

afterEach(resetReadingStore);

describe('device reading in the device panel (sign-off r100)', () => {
  it('lists what differs, offers Accept all, and counts it on the chip', () => {
    const { doc, device } = estate();
    seedReading(DESIGN, device, { panel: { status: 'ready', value: panel() } }, ORG, on);
    const place: ReadingPlace = { organisation: ORG, design: DESIGN, doc, canDraw: true, onEdit: () => undefined };
    const tab = render(place, createElement(ReadingsTab, { deviceId: device }));
    expect(tab).toContain('Differs from the drawing · 3');
    expect(tab).toContain('JAE24410ABC');
    expect(tab).toContain('Add cable');
    expect(tab).toContain('Accept all 3');
    expect(tab).toContain('by <b>Key Maker</b>');
    expect(tab).toContain('Took 4.2 s. 1 ports up, 0 down.');
    expect(tab).toContain('Earlier readings');
    expect(tab).toContain('by Sam Ortiz');
    expect(tab).toContain('Read MAC and ARP');
    expect(render(place, createElement(ReadingChip, { deviceId: device }))).toContain('3 differ from drawing');
    expect(render(place, createElement(ReadLine, { deviceId: device }))).toContain('Read <b>today at');
  });

  it('says a plan under way and an open issue, marks the row a plan sets, and leaves it out of Accept all (r106)', () => {
    let { doc, device } = estate();
    const gate = TYPED_AS_WRITTEN;
    const p = createPlan(doc, { title: 'Swap the chassis', gate, ...tick() });
    doc = addStep(p.doc, p.id, { kind: 'other', change: 'Record the serial', edit: { t: 'field', id: chassisOf(doc, device), key: 'Chassis.serial', value: 'FOC99' }, gate, ...tick() }).doc;
    doc = startPlan(doc, p.id, tick());
    doc = createIssue(doc, { deviceId: device, title: 'Uplink flapping', steps: [{ topic: 'link', question: 'Is the uplink up?' }], gate, ...tick() }).doc;
    seedReading(DESIGN, device, { panel: { status: 'ready', value: panel() } }, ORG, on);
    const place: ReadingPlace = { organisation: ORG, design: DESIGN, doc, canDraw: true, onEdit: () => undefined };
    const tab = render(place, createElement(ReadingsTab, { deviceId: device }));
    expect(tab).toContain('Plan “Swap the chassis” is under way on this device. Read now still reads');
    expect(tab).toContain('“Uplink flapping” is open on this device');
    expect(tab).toContain('The plan “Swap the chassis”, under way now, sets this to FOC99. Accepting it here would put back what the plan changes.');
    expect(tab).toContain('Accept all 2');
    expect(tab).toContain('Leaves out 1 a plan changes.');
    expect(render(place, createElement(ReadLine, { deviceId: device }))).toContain('Plan “Swap the chassis” under way');
  });

  it('shows a reader nothing to press, and a dismissed difference not at all', () => {
    const { doc, device } = estate();
    seedReading(DESIGN, device, { panel: { status: 'ready', value: panel({ dismissed: [{ field: 'serial', value: 'JAE24410ABC' }] }) } }, ORG, on);
    const place: ReadingPlace = { organisation: ORG, design: DESIGN, doc, canDraw: false, onEdit: () => undefined };
    const tab = render(place, createElement(ReadingsTab, { deviceId: device }));
    expect(tab).toContain('Differs from the drawing · 2');
    expect(tab).not.toContain('JAE24410ABC');
    expect(tab).not.toContain('Accept');
    expect(tab).not.toContain('Dismiss');
    expect(render(place, createElement(ReadNow, { deviceId: device }))).toBe('');
  });

  it('says never read, and shows nothing where the server does not read devices', () => {
    const { doc, device } = estate();
    seedReading(DESIGN, device, { panel: { status: 'ready', value: panel({ readings: [] }) } }, ORG, on);
    const place: ReadingPlace = { organisation: ORG, design: DESIGN, doc, canDraw: true, onEdit: () => undefined };
    expect(render(place, createElement(ReadingsTab, { deviceId: device }))).toContain('Never read.');
    expect(render(place, createElement(ReadLine, { deviceId: device }))).toContain('Never read');
    // Read now is there, held until the logins have loaded.
    expect(render(place, createElement(ReadNow, { deviceId: device }))).toMatch(/<button[^>]*disabled=""[^>]*data-testid="read-now"/);
    resetReadingStore();
    seedReading(DESIGN, device, { panel: { status: 'ready', value: panel() } }, ORG, { ...on, server: false });
    expect(render(place, createElement(ReadingsTab, { deviceId: device }))).toBe('');
    expect(render(place, createElement(ReadingChip, { deviceId: device }))).toBe('');
  });

  it('says a refusal once, in words, with what to do', () => {
    const { doc, device } = estate();
    const halt = { kind: 'failed' as const, code: 'engine_changed', message: 'x', engineId: '800000090300AAAA91A2B3C4', previous: '8000000903001C2B3D4E5F60', read: 'device' as const };
    seedReading(DESIGN, device, { panel: { status: 'ready', value: panel() }, halt }, ORG, on);
    const place: ReadingPlace = { organisation: ORG, design: DESIGN, doc, canDraw: true, onEdit: () => undefined };
    const tab = render(place, createElement(ReadingsTab, { deviceId: device }));
    expect(tab).toContain("this isn&#x27;t the device Fathom read before");
    expect(tab).toContain('from …3D4E5F60 to …91A2B3C4');
    expect(tab).toContain('Confirm the new one');
  });
});

describe('when Read now can be pressed', () => {
  const entry = (over: Partial<VaultEntry>): VaultEntry =>
    ({ id: 'L1', name: 'core-ro', kind: 'snmp', readOnly: true, snmpAuth: 'sha256', fathom: { state: 'on' }, usedOn: [], ...over }) as VaultEntry;

  it('offers logins marked on the device or set for its range, read-only SNMP with a copy for Fathom', () => {
    const range = { cidr: '10.20.0.0/24', snmpPort: 161, sshPort: 22, login: 'L2' };
    const list = usableLogins(
      [
        entry({ usedOn: [{ design: DESIGN, element: 'dev' }] }),
        entry({ id: 'L2', name: 'range-ro' }),
        entry({ id: 'L3', usedOn: [{ design: DESIGN, element: 'dev' }], readOnly: false }),
        entry({ id: 'L4', usedOn: [{ design: DESIGN, element: 'dev' }], fathom: null }),
      ],
      DESIGN,
      'dev',
      range,
    );
    expect(list.map((l) => [l.entry.id, l.from])).toEqual([
      ['L1', 'Marked on this device'],
      ['L2', 'Set for the range 10.20.0.0/24'],
    ]);
  });

  it('gives the first reason it cannot', () => {
    const one = [{ entry: entry({}), from: '' }];
    expect(whyOff({ ...on, on: false }, '10.20.0.14', one)?.head).toBe('Reading is off');
    expect(whyOff(on, null, one)?.head).toBe('No management address');
    expect(whyOff(on, '10.40.1.9', one)?.todo).toBe("10.40.1.9 isn't in a range a Steward has listed.");
    expect(whyOff(on, '10.20.0.14', [])?.head).toBe('No read-only login');
    expect(whyOff({ ...on, reader: false }, '10.20.0.14', one)?.head).toBe("The reader isn't answering");
    expect(whyOff(on, '10.20.0.14', one)).toBeNull();
  });

  it('says when in words a person reads', () => {
    const now = new Date(2026, 10, 2, 21, 0).getTime();
    expect(when(new Date(2026, 10, 2, 20, 14).getTime(), now)).toBe('today at 20:14');
    expect(when(new Date(2026, 10, 1, 9, 2).getTime(), now)).toBe('yesterday at 09:02');
    expect(when(new Date(2026, 9, 28, 16, 40).getTime(), now)).toBe('28 Oct at 16:40');
  });
});
