import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { adminBody, ceilingBody, changeWords, parseAdminSettings, parseStewardSettings, stewardBody } from '../../api/firmwareSettings';
import { FirmwareSettingsView } from '../organisation/FirmwareSettingsPage';
import { FirmwareSectionView, organisationRows, valueOf } from './FirmwareSection';

// Admin › Firmware and Steward › Firmware (sign-off r71). Render-to-string, per
// `ConsoleTabs.render.test.ts`; the JSON is the shape `operators.rs::firmware_overview` and
// `firmware.rs`'s settings page answer.

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytes = (v: unknown) => enc.encode(JSON.stringify(v));

const file = {
  fetch_base_url: 'http://10.0.0.5:8080',
  max_image_bytes: 2147483648,
  organisation_max_bytes: 21474836480,
  total_max_bytes: 53687091200,
  upload_idle_seconds: 120,
  uploads_per_organisation: 1,
  uploads_per_server: 3,
};
const none = Object.fromEntries(Object.keys(file).map((k) => [k, null]));

const admin = {
  on: true,
  file,
  server: { saved: { ...none, total_max_bytes: 100e9 }, changed_at_unix: 1793000000, version: 2 },
  limits: { ...file, total_max_bytes: 100e9, organisation_ceiling: 21474836480 },
  organisations: [
    {
      organisation: '01ORGA',
      ceiling_bytes: 5e9,
      locked: true,
      lock_reason: 'Over budget until Q1',
      changed_at_unix: 1793000100,
      version: 1,
      own: { max_bytes: 3e9, fetch_base_url: 'http://192.0.2.10:8080', set_at_unix: 1793000050 },
      verifies: false,
    },
  ],
  history: [
    {
      seq: 7,
      type: 'firmware_ceiling_changed',
      at_unix: 1793000100,
      operator: 'op_1',
      organisation: '01ORGA',
      after: { ceiling_bytes: 5e9, locked: true, lock_reason: 'Over budget until Q1' },
    },
  ],
};

const steward = {
  limits: { ...file, organisation_max_bytes: 3e9, organisation_ceiling: 5e9 },
  file,
  server: none,
  ceiling: { ceiling_bytes: 5e9, locked: false, lock_reason: null, changed_at_unix: 1793000100, version: 1 },
  own: { max_bytes: 3e9, fetch_base_url: null, set_at_unix: 1793000050 },
  history: [
    {
      seq: 3,
      type: 'firmware_org_settings_changed',
      at_unix: 1793000050,
      by_name: 'Robin',
      after: { max_bytes: 3e9, fetch_base_url: null },
    },
  ],
};

const noop = () => {};

describe('the firmware settings pages', () => {
  it('reads the Admin page and calls a missing answer off', () => {
    const s = parseAdminSettings(bytes(admin));
    if (!s.on) throw new Error('expected on');
    expect(s.saved.totalMaxBytes).toBe(100e9);
    expect(s.saved.maxImageBytes).toBeNull();
    expect(s.version).toBe(2);
    expect(s.organisations[0]!.verifies).toBe(false);
    expect(s.history[0]!.byAdmin).toBe(true);
    expect(parseAdminSettings(bytes({ on: false }))).toEqual({ on: false });
  });

  it('writes canonical bodies, keys in order, with the trailing newline', () => {
    const s = parseAdminSettings(bytes(admin));
    if (!s.on) throw new Error('expected on');
    const body = dec.decode(adminBody(s.saved, 2));
    expect(body.endsWith('\n')).toBe(true);
    expect(Object.keys(JSON.parse(body))).toEqual([...Object.keys(JSON.parse(body))].sort());
    expect(dec.decode(stewardBody(null, 'http://10.0.0.9'))).toBe('{"fetch_base_url":"http://10.0.0.9","max_bytes":null}\n');
    expect(JSON.parse(dec.decode(ceilingBody(5e9, true, 'why', 1)))).toEqual({ ceiling_bytes: 5e9, if_version: 1, lock_reason: 'why', locked: true });
  });

  it('reads a box as the value to save', () => {
    expect(valueOf('gb', '2.5')).toBe(2.5e9);
    expect(valueOf('gb', '')).toBeNull();
    expect(valueOf('count', '3')).toBe(3);
    expect(valueOf('count', '3x')).toBeNaN();
    expect(valueOf('url', ' http://a ')).toBe('http://a');
  });

  it('lists every organisation, with or without a ceiling', () => {
    const s = parseAdminSettings(bytes(admin));
    if (!s.on) throw new Error('expected on');
    const rows = organisationRows(
      [
        { id: '01ORGA', displayName: 'Acme' },
        { id: '01ORGB', displayName: 'Bravo' },
      ] as never,
      s.organisations,
    );
    expect(rows.map((r) => [r.name, r.row?.version ?? null])).toEqual([
      ['Acme', 1],
      ['Bravo', null],
    ]);
  });

  it('shows the file beside the saved values, the lock, a seal that does not check, and the history', () => {
    const html = renderToStaticMarkup(
      createElement(FirmwareSectionView, {
        settings: parseAdminSettings(bytes(admin)),
        organisations: [{ id: '01ORGA', displayName: 'Acme' }] as never,
        busy: false,
        error: null,
        notice: null,
        onSaveServer: noop,
        onSaveOrganisation: noop,
      }),
    );
    expect(html).toContain('settings file');
    expect(html).toContain('<code>54 GB</code>');
    expect(html).toContain('placeholder="21.5"');
    expect(html).toContain('100 GB');
    expect(html).toContain('Over budget until Q1');
    expect(html).toContain('do not match their seal');
    expect(html).toContain('http://192.0.2.10:8080');
    expect(html).toContain('The server’s admin set the ceiling to 5 GB, locked: “Over budget until Q1” (Acme)');
    expect(html).toContain('Reset to the file');
  });

  it('says when no download address is set anywhere, on both pages', () => {
    const nowhere = { ...file, fetch_base_url: null };
    const html = renderToStaticMarkup(
      createElement(FirmwareSectionView, {
        settings: parseAdminSettings(bytes({ ...admin, file: nowhere, server: { ...admin.server, saved: none }, limits: { ...admin.limits, fetch_base_url: null } })),
        organisations: [],
        busy: false,
        error: null,
        notice: null,
        onSaveServer: noop,
        onSaveOrganisation: noop,
      }),
    );
    expect(html).toContain('admin-firmware-no-address');
    expect(html).toContain('not set');
    const steward2 = renderToStaticMarkup(
      createElement(FirmwareSettingsView, {
        settings: parseStewardSettings(bytes({ ...steward, file: nowhere, limits: { ...steward.limits, fetch_base_url: null } })),
        busy: false,
        error: null,
        notice: null,
        onSave: noop,
      }),
    );
    expect(steward2).toContain('steward-firmware-no-address');
    expect(steward2).toContain('Not set yet');
  });

  it('says firmware is off when it is', () => {
    const html = renderToStaticMarkup(
      createElement(FirmwareSectionView, {
        settings: { on: false },
        organisations: [],
        busy: false,
        error: null,
        notice: null,
        onSaveServer: noop,
        onSaveOrganisation: noop,
      }),
    );
    expect(html).toContain('writable folder at /var/lib/fathom/firmware');
    expect(html).not.toContain('Save');
  });

  it('gives a Steward their total, the ceiling, the address and who changed what', () => {
    const html = renderToStaticMarkup(
      createElement(FirmwareSettingsView, {
        settings: parseStewardSettings(bytes(steward)),
        busy: false,
        error: null,
        notice: null,
        onSave: noop,
      }),
    );
    expect(html).toContain('5 GB, set by the server’s admin');
    expect(html).toContain('value="3"');
    expect(html).toContain('placeholder="http://10.0.0.5:8080"');
    expect(html).toContain('Robin set the total to 3 GB and the download address back to the server’s');
    expect(html).not.toContain('steward-firmware-locked');
  });

  it('shows a Steward the lock and its reason, with nothing to change', () => {
    const locked = { ...steward, ceiling: { ...steward.ceiling, locked: true, lock_reason: 'Audit week' } };
    const html = renderToStaticMarkup(
      createElement(FirmwareSettingsView, {
        settings: parseStewardSettings(bytes(locked)),
        busy: false,
        error: null,
        notice: null,
        onSave: noop,
      }),
    );
    expect(html).toContain('steward-firmware-locked');
    expect(html).toContain('“Audit week”');
    expect(html).toMatch(/data-testid="steward-firmware-save" disabled=""/);
  });

  it('words each kind of change', () => {
    const base = { seq: 1, atUnix: 0, byAdmin: false, byName: null, organisation: null, before: null };
    expect(changeWords({ ...base, type: 'firmware_server_settings_changed', byAdmin: true, after: {} })).toBe(
      'The server’s admin changed the server’s firmware settings',
    );
    expect(changeWords({ ...base, type: 'firmware_ceiling_changed', byAdmin: true, after: { ceiling_bytes: null, locked: false } })).toBe(
      'The server’s admin set the ceiling to the server’s default, unlocked',
    );
  });
});
