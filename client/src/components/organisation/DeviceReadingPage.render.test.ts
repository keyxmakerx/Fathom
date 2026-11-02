import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { parseDeviceReading, rangeProblem, setBody, type DeviceReading } from '../../api/deviceRead';
import { DeviceReadingView, notReadyWords, rowsToRanges } from './DeviceReadingPage';

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
    ).toEqual({ ranges: [{ cidr: '10.20.0.0/24', snmpPort: 161, sshPort: 2222 }] });
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
      ranges: [{ cidr: '10.20.0.0/24', snmpPort: 161, sshPort: 22 }],
      setBy: 'A',
      setAt: 5,
    });
  });
});
