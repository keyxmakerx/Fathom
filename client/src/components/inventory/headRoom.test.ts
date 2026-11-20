import { describe, expect, it } from 'vitest';

import type { FieldDefView } from '../../api/fieldDefinitions';
import { HEAD_ROOM_MAX, headRoom, headTextWidth } from './headRoom';
import { allColumns, KINDS } from './kinds';

// What Chromium measured for each built-in head in the running app, in Liberation Sans, on 2026-11-20.
const MEASURED: ReadonlyArray<readonly [string, number]> = [
  ['Name', 32.91], ['Model', 40.57], ['Role', 31.24], ['Mgmt address', 92.94], ['In Termix', 59.4], ['Serial', 41.58],
  ['Running', 53.68], ['Firmware', 62.08], ['Where', 42.24], ['Ports', 39.29], ['Power', 42.79], ['Inlets', 41.02],
  ['Cables', 45.47], ['Last change', 81.4], ['Height (U)', 64.27], ['Row', 27.46], ['Bay', 22.29], ['Used', 31.8],
  ['Devices', 50.91], ['Free', 30.68], ['Label', 36.15], ['Kind', 27.91], ['Media', 36.68], ['Sheath', 45.83],
  ['Length (m)', 68.35], ['Ownership', 70.68], ['End A', 35.02], ['End B', 35.57], ['Port', 31.61], ['Device', 43.24],
  ['Connector', 73.27], ['Service', 50.74], ['Face', 30.13], ['Uplink', 42.13], ['Cable to', 57.11], ['MAC', 25.24],
  ['Part', 29.75], ['In', 12], ['Model or part no.', 118.88], ['Platform', 61.72], ['Chosen version', 104.58],
  ['Behind', 43.8], ['Held', 30.69], ['Prefix', 42.13], ['VLAN', 30.13], ['Site', 26.24], ['Gateway', 55.16],
  ['Prefixes', 57.47], ['Members', 57.57], ['Address', 55.36], ['Interface', 65.13], ['Subnet', 46.57], ['Tags', 30.49],
];

describe('headTextWidth', () => {
  // The browser kerns a few pairs closer, so the sum of the advances is the measured width or a little over.
  it('is what a browser measures, or up to 2px more, for every built-in head', () => {
    for (const [label, measured] of MEASURED) {
      const d = headTextWidth(label) - measured;
      expect(d, label).toBeGreaterThan(-0.05);
      expect(d, label).toBeLessThan(2);
    }
  });

  it('has a measurement for every built-in head', () => {
    const known = new Set(MEASURED.map(([label]) => label));
    for (const { key } of KINDS) for (const col of allColumns(key, [])) expect(known.has(col.label), `${key} › ${col.label}`).toBe(true);
  });

  it('measures the capitals, whatever case the label is written in', () => {
    expect(headTextWidth('mgmt address')).toBe(headTextWidth('MGMT ADDRESS'));
  });

  it('gives an accented capital its letter\'s width, and an unknown character a full em', () => {
    expect(headTextWidth('É')).toBe(headTextWidth('E'));
    expect(headTextWidth('場所')).toBe(22);
    expect(headTextWidth('')).toBe(0);
  });
});

describe('headRoom', () => {
  it('is the text, a little over, and what stands beside it', () => {
    expect(headRoom('Height (U)')).toBe(122);
    expect(headRoom('In')).toBe(67);
  });

  it('stops growing for a very long name', () => {
    expect(headRoom('Date the extended warranty on this device runs out')).toBe(HEAD_ROOM_MAX);
  });
});

describe('every column has room for its head', () => {
  it('the built-in columns of every kind', () => {
    for (const { key } of KINDS) {
      for (const col of allColumns(key, [])) expect(col.width, `${key} › ${col.label}`).toBeGreaterThanOrEqual(headRoom(col.label));
    }
  });

  it('keeps a column that was already wide enough as it was', () => {
    const byKey = new Map(allColumns('devices', []).map((c) => [c.key, c.width]));
    expect(byKey.get('name')).toBe(150);
    expect(byKey.get('where')).toBe(150);
    expect(byKey.get('tags')).toBe(160);
  });

  it('a custom field with a long name', () => {
    const def = (id: string, name: string, type: FieldDefView['type']): FieldDefView => ({ id, appliesTo: 'device', name, type, choices: [], version: 1, createdBy: 'a', archived: false });
    const cols = allColumns('devices', [def('f1', 'Warranty ends', 'date'), def('f2', 'Owner', 'text'), def('f3', 'Next maintenance window', 'text')]);
    const width = (name: string) => cols.find((c) => c.label === name)!.width;
    expect(width('Warranty ends')).toBe(headRoom('Warranty ends'));
    expect(width('Warranty ends')).toBeGreaterThan(100);
    expect(width('Owner')).toBe(140);
    expect(width('Next maintenance window')).toBe(headRoom('Next maintenance window'));
  });
});
