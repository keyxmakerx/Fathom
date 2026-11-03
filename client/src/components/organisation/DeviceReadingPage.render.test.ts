import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { parseDeviceReading, rangeProblem, setBody, type DeviceReading } from '../../api/deviceRead';
import type { VaultEntry } from '../../api/vault';
import { DeviceReadingView, EnginesView, notReadyWords, rangeLogins, rowsToRanges } from './DeviceReadingPage';

const LOGIN = '01J9Z0000000000000000LOGIN';

const noop = () => undefined;
const base: DeviceReading = { server: true, reader: true, on: false, usable: false, ranges: [], setBy: null, setAt: null };
const view = (settings: DeviceReading) =>
  renderToStaticMarkup(createElement(DeviceReadingView, { settings, busy: false, error: null, notice: null, onSave: noop }));

describe('Steward › Device reading (ADR-0082 §4.4)', () => {
  it('says why it cannot be turned on while the server does not read, and keeps the switch shut', () => {
    const out = view({ ...base, server: false, reader: false });
    expect(out).toContain('FATHOM_DEVICE_READ=on');
    expect(out).toMatch(/data-testid="device-reading-on"[^>]*disabled/);
  });

  it('says so when the server allows it but its reader is not answering', () => {
    expect(notReadyWords({ ...base, reader: false })).toContain('reader is not answering');
    expect(notReadyWords(base)).toBeNull();
  });

  it('lists the ranges a Steward set, with their ports, and never promises more than reading', () => {
    const out = view({ ...base, on: true, usable: true, ranges: [{ cidr: '10.20.0.0/24', snmpPort: 1161, sshPort: 22 }], setAt: 1_793_590_000_000 });
    expect(out).toContain('value="10.20.0.0/24"');
    expect(out).toContain('value="1161"');
    expect(out).toContain('It never changes one');
    expect(out).toContain('Last changed');
    expect(out).not.toMatch(/data-testid="device-reading-on"[^>]*disabled/);
  });
});

describe('ranges as typed', () => {
  it('drops empty rows, fills the default ports and names the row with a problem', () => {
    expect(
      rowsToRanges([
        { cidr: ' 10.20.0.0/24 ', snmpPort: '', sshPort: '2222' },
        { cidr: '', snmpPort: '', sshPort: '' },
      ]),
    ).toEqual({ ranges: [{ cidr: '10.20.0.0/24', snmpPort: 161, sshPort: 2222, login: null }] });
    expect(rowsToRanges([{ cidr: '10.20.0.0/24', snmpPort: '', sshPort: '', login: LOGIN }])).toEqual({ ranges: [{ cidr: '10.20.0.0/24', snmpPort: 161, sshPort: 22, login: LOGIN }] });
    expect(rowsToRanges([{ cidr: '10.20.0.0', snmpPort: '', sshPort: '' }])).toEqual({ problem: 'Range 1: Add a prefix length, such as /24.' });
    expect(rowsToRanges([{ cidr: '10.20.0.0/24', snmpPort: '70000', sshPort: '' }])).toEqual({ problem: 'Range 1: a port is 1 to 65535.' });
  });

  it('catches a range wider than the server allows before it is sent', () => {
    expect(rangeProblem('0.0.0.0/0')).toBe('An IPv4 range is /8 to /32.');
    expect(rangeProblem('2001:db8::/16')).toBe('An IPv6 range is /32 to /128.');
    expect(rangeProblem('10.0.0.0/8')).toBeNull();
  });

  it('sends the switch and the list, leaving default ports out', () => {
    expect(setBody(true, [{ cidr: '10.20.0.0/24', snmpPort: 161, sshPort: 22 }, { cidr: '2001:db8::/48', snmpPort: 1161, sshPort: 2222 }])).toBe(
      '{"on":true,"ranges":[{"cidr":"10.20.0.0/24"},{"cidr":"2001:db8::/48","snmpPort":1161,"sshPort":2222}]}\n',
    );
    // A login set for the range sorts between cidr and the ports, as canonical JSON does.
    expect(setBody(false, [{ cidr: '10.20.0.0/24', snmpPort: 1161, sshPort: 22, login: LOGIN }])).toBe(
      `{"on":false,"ranges":[{"cidr":"10.20.0.0/24","login":"${LOGIN}","snmpPort":1161}]}\n`,
    );
  });

  it('reads the server’s answer', () => {
    const answer = new TextEncoder().encode(
      '{"on":true,"ranges":[{"cidr":"10.20.0.0/24","snmpPort":161,"sshPort":22}],"reader":true,"server":true,"setAt":5,"setBy":"A","usable":true}\n',
    );
    expect(parseDeviceReading(answer)).toEqual({
      server: true,
      reader: true,
      on: true,
      usable: true,
      ranges: [{ cidr: '10.20.0.0/24', snmpPort: 161, sshPort: 22, login: null }],
      setBy: 'A',
      setAt: 5,
    });
  });
});

describe('a login per range, and agents waiting (sign-off r100)', () => {
  const entry = (over: Partial<VaultEntry>): VaultEntry =>
    ({ id: LOGIN, name: 'core-ro', kind: 'snmp', readOnly: true, snmpAuth: 'sha256', fathom: { state: 'on' }, usedOn: [], ...over }) as VaultEntry;

  it('offers only read-only SNMP logins with their authentication said and a copy for Fathom', () => {
    expect(rangeLogins([entry({}), entry({ id: 'b', readOnly: false }), entry({ id: 'c', kind: 'login' }), entry({ id: 'd', snmpAuth: null }), entry({ id: 'e', fathom: null })])).toEqual([
      { id: LOGIN, name: 'core-ro', auth: 'SHA-256' },
    ]);
    const out = renderToStaticMarkup(
      createElement(DeviceReadingView, {
        settings: { ...base, on: true, ranges: [{ cidr: '10.20.0.0/24', snmpPort: 161, sshPort: 22, login: LOGIN }] },
        busy: false,
        error: null,
        notice: null,
        onSave: noop,
        logins: [{ id: LOGIN, name: 'core-ro', auth: 'SHA-256' }],
      }),
    );
    expect(out).toContain('core-ro · SNMPv3 SHA-256');
    expect(out).toMatch(new RegExp(`value="${LOGIN}" selected`));
  });

  it('groups agents by range, approves the new ones together and a changed one alone', () => {
    const e = (address: string, state: 'seen' | 'changed' | 'approved') => ({
      address,
      design: 'd',
      element: 'e',
      engineId: '8000000903001C2B3D4E5F60',
      previous: state === 'changed' ? '800000090300AAAA91A2B3C4' : null,
      state,
      seenAt: 0,
      approvedBy: null,
    });
    const out = renderToStaticMarkup(
      createElement(EnginesView, {
        engines: [e('10.20.0.14', 'seen'), e('10.20.0.15', 'seen'), e('10.20.0.3', 'changed'), e('10.20.0.4', 'approved')],
        ranges: [{ cidr: '10.20.0.0/24', snmpPort: 161, sshPort: 22 }],
        busy: false,
        error: null,
        onApprove: noop,
      }),
    );
    expect(out).toContain('Approve 2 new');
    expect(out).toContain('changed since last read (was …91A2B3C4)');
    expect(out).toContain('Approve this one');
    expect(out).not.toContain('10.20.0.4<');
    expect(out).toContain('…3D4E5F60');
  });
});
