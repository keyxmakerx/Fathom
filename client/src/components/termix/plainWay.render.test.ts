// ADR-0080 decisions 2 and 8: a plan's devices with Open in Termix beside them, and the plain way,
// always there, Termix or not.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ConnectLines } from './ConnectLines';
import { PlanDevices } from './PlanDevices';
import { TermixActions } from './TermixActions';
import { USER_PLACEHOLDER, connectWays, sshLine } from './connect';

describe('the ssh line', () => {
  it('is ssh <your user>@<address>, without a prefix length or brackets', () => {
    expect(sshLine('10.0.0.1/24')).toBe(`ssh ${USER_PLACEHOLDER}@10.0.0.1`);
    expect(sshLine('[2001:db8::1]')).toBe(`ssh ${USER_PLACEHOLDER}@2001:db8::1`);
    expect(sshLine('core-sw1.lab.example')).toBe(`ssh ${USER_PLACEHOLDER}@core-sw1.lab.example`);
  });

  it('is not offered for text that is not an address, so nothing typed into a design becomes a command', () => {
    expect(sshLine('10.0.0.1; rm -rf ~')).toBeNull();
    expect(sshLine('$(whoami)')).toBeNull();
    expect(sshLine('')).toBeNull();
    expect(connectWays('not an address')).toEqual([]);
  });

  it('has a way for Windows and one for Linux', () => {
    expect(connectWays('10.0.0.1').map((w) => w.os)).toEqual(['windows', 'linux']);
    expect(connectWays('10.0.0.1')[0]!.note).toContain('OpenSSH Client');
  });
});

describe('ConnectLines', () => {
  it('shows the address with Copy and both lines, open when nothing else is beside it', () => {
    const html = renderToStaticMarkup(createElement(ConnectLines, { address: '10.0.0.1' }));
    expect(html).toContain('<details class="termix-plain" open=""');
    expect(html).toContain('Copy address');
    expect(html).toContain('From Windows (PowerShell)');
    expect(html).toContain('From Linux');
    expect(html).toContain('ssh &lt;your user&gt;@10.0.0.1');
  });

  it('folds under a Termix button', () => {
    expect(renderToStaticMarkup(createElement(ConnectLines, { address: '10.0.0.1', folded: true }))).not.toContain('open=""');
  });

  it('shows nothing for an address ssh cannot take', () => {
    expect(renderToStaticMarkup(createElement(ConnectLines, { address: 'x y' }))).toBe('');
  });
});

describe('a plan’s devices', () => {
  const devices = [
    { id: 'Device:a', name: 'core-sw1', address: '10.0.0.1' },
    { id: 'Device:b', name: 'ap-3', address: '' },
  ];

  it('without Termix: every device with its address, Copy and the ssh lines, and no Termix button', () => {
    const html = renderToStaticMarkup(createElement(PlanDevices, { devices, heading: 'Devices' }));
    expect(html).toContain('Devices');
    expect(html).toContain('core-sw1');
    expect(html).toContain('ssh &lt;your user&gt;@10.0.0.1');
    expect(html).not.toContain('Open in Termix');
    expect(html).toContain('No management address');
  });

  it('nothing when the plan names no device', () => {
    expect(renderToStaticMarkup(createElement(PlanDevices, { devices: [] }))).toBe('');
  });

  it('Open in Termix inline has no field label', () => {
    const html = renderToStaticMarkup(createElement(TermixActions, { name: 'core-sw1', address: '10.0.0.1', origin: 'https://termix.example.lan', inline: true }));
    expect(html).toContain('termix-inline');
    expect(html).toContain('Open in Termix');
    expect(html).not.toContain('drawing-editor__field-label');
  });
});
