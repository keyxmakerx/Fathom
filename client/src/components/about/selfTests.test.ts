import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { About } from '../../api/about';
import { parseAbout } from '../../api/about';
import { AboutSheet, CONNECTION_ROWS } from './AboutSheet';
import { CANARY_SECRET, runSelfTests, type SelfTestDeps } from './selfTests';

const ABOUT: About = {
  version: '0.1.0',
  commit: 'abc123',
  built: '2026-11-14T10:00:00Z',
  reader: true,
  connections: {
    deviceRead: false,
    outsideVaults: false,
    passbolt: false,
    offsiteBackup: false,
    auditSyslog: false,
    accessSyslog: false,
    termix: false,
  },
};

const good = (over: Partial<SelfTestDeps> = {}): SelfTestDeps => ({
  health: () => Promise.resolve('ok\n'),
  about: () => Promise.resolve(ABOUT),
  pageCommit: 'abc123',
  redact: (t) => Promise.resolve(t.replace(CANARY_SECRET, '[removed]')),
  location: { protocol: 'https:', hostname: 'fathom.example' },
  pagePolicy: () => Promise.resolve("default-src 'none'; script-src 'self'"),
  ...over,
});

const outcomes = async (deps: SelfTestDeps) =>
  Object.fromEntries((await runSelfTests(deps)).results.map((r) => [r.id, r.outcome]));

describe('About this Fathom: self-tests', () => {
  it('passes everything on a healthy, stamped, HTTPS server, and skips the reader when it is off', async () => {
    expect(await outcomes(good())).toEqual({ server: 'pass', build: 'pass', gate: 'pass', protections: 'pass' });
  });

  it('fails the gate check when the test password comes back untouched', async () => {
    expect((await outcomes(good({ redact: (t) => Promise.resolve(t) }))).gate).toBe('fail');
  });

  it('fails the gate check when the engine will not start, without throwing', async () => {
    expect((await outcomes(good({ redact: () => Promise.reject(new Error('no wasm')) }))).gate).toBe('fail');
  });

  it('fails the build check when page and server differ, and skips it in a development build', async () => {
    expect((await outcomes(good({ pageCommit: 'def456' }))).build).toBe('fail');
    expect((await outcomes(good({ pageCommit: '' }))).build).toBe('skip');
  });

  it('fails the server check when health does not answer ok', async () => {
    expect((await outcomes(good({ health: () => Promise.resolve('no') }))).server).toBe('fail');
    expect((await outcomes(good({ health: () => Promise.reject(new Error('down')) }))).server).toBe('fail');
  });

  it('fails protections over plain HTTP, and on a policy that is not Fathom’s', async () => {
    expect((await outcomes(good({ location: { protocol: 'http:', hostname: 'fathom.example' } }))).protections).toBe('fail');
    expect((await outcomes(good({ pagePolicy: () => Promise.resolve("default-src *") }))).protections).toBe('fail');
    expect((await outcomes(good({ pagePolicy: () => Promise.resolve(null) }))).protections).toBe('fail');
  });

  it('only skips a missing policy on a development server on this machine', async () => {
    const dev = good({ location: { protocol: 'http:', hostname: 'localhost' }, pagePolicy: () => Promise.resolve(null) });
    expect((await outcomes(dev)).protections).toBe('skip');
  });

  it('checks the reader only when device reading is on', async () => {
    const on = { ...ABOUT, connections: { ...ABOUT.connections, deviceRead: true } };
    expect((await outcomes(good({ about: () => Promise.resolve(on) }))).reader).toBe('pass');
    expect((await outcomes(good({ about: () => Promise.resolve({ ...on, reader: false }) }))).reader).toBe('fail');
  });
});

describe('About this Fathom: what the server says', () => {
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
  const wire = {
    built: '',
    commit: '',
    reader: false,
    version: '0.1.0',
    connections: {
      access_syslog: false,
      audit_syslog: true,
      device_read: false,
      offsite_backup: false,
      outside_vaults: false,
      passbolt: false,
      termix: false,
    },
  };

  it('reads the server’s answer', () => {
    expect(parseAbout(enc(wire)).connections.auditSyslog).toBe(true);
  });

  it('refuses a connection that is anything but true or false, so no address can be shown', () => {
    expect(() => parseAbout(enc({ ...wire, connections: { ...wire.connections, passbolt: 'vault.example' } }))).toThrow();
  });

  it('has a row for every connection the server reports', () => {
    expect(CONNECTION_ROWS.map((r) => r.key).sort()).toEqual(Object.keys(parseAbout(enc(wire)).connections).sort());
  });
});

describe('About this Fathom: the sheet', () => {
  it('renders as a labelled dialog with every connection row', () => {
    const markup = renderToStaticMarkup(createElement(AboutSheet, { onClose: () => {}, deps: good() }));
    expect(markup).toContain('aria-label="About this Fathom"');
    for (const row of CONNECTION_ROWS) expect(markup).toContain(row.label);
  });
});
