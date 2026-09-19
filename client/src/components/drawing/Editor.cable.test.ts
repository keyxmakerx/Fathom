import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ClosetView, EditorActions } from './contract';
import { EditorFor, cableEndText, disconnectCableChange, setCableFieldChange } from './Editor';
import { COPPER_SHEATHS, FIBRE_SHEATHS, POWER_SHEATHS } from './sheath';

// UI-SPEC "Cables" — the selected cable's own panel (this session's brief).
// Render-to-string smoke tests only, the same shape `Editor.render.test.ts`'s
// own file header gives every other panel here (no DOM testing library is
// installed, so a click is never simulated, only the markup a given state
// would produce).

const VIEW: ClosetView = {
  premisesId: 'closet-1',
  rows: [],
  surfaces: [
    {
      id: 'surface-1',
      label: 'West wall',
      form: 'wall',
      widthMm: 3000,
      heightMm: 2400,
      fixtures: [
        {
          id: 'outlet-1',
          kind: 'passive',
          label: 'outlet-w1',
          model: null,
          form: 'outlet',
          xMm: 300,
          yMm: 1200,
          ports: [
            { id: 'outlet-port-1', label: '1', connector: 'rj45', row: 0, column: 0, uplink: false, role: null, face: 'front', passThroughId: null, cable: null },
          ],
          psuInlets: [],
          fixtures: [],
        },
      ],
    },
  ],
  racks: [
    {
      id: 'rack-1',
      label: 'A-04',
      heightU: 42,
      unitNumbering: 'bottom-up',
      row: null,
      bay: null,
      freeRuns: [{ fromU: 1, toU: 10 }],
      shelves: [
        {
          id: 'shelf-1',
          label: 'shelf-a01',
          positionU: 20,
          heightU: 2,
          occupants: [
            {
              id: 'occ-1',
              kind: 'chassis',
              label: 'nuc-01',
              model: null,
              slot: 1,
              sketch: true,
              ports: [
                { id: 'occ-port-1', label: 'eth0', connector: 'rj45', row: 0, column: 0, uplink: false, role: null, face: 'front', passThroughId: null, cable: null },
              ],
            },
          ],
        },
      ],
      chassis: [
        {
          id: 'chassis-1',
          deviceId: 'device-1',
          hostname: 'core-01',
          model: 'EX4300-48P',
          vendor: 'juniper',
          positionU: 38,
          heightU: 1,
          face: 'front',
          ports: [
            { id: 'port-1', label: '0', connector: 'RJ45', row: 0, column: 0, role: null, face: 'front', uplink: false, cable: null, passThroughId: null },
          ],
          role: null,
          managementAddress: null,
          serial: null,
          psuInlets: [],
          singleFed: false,
          oneFitted: false,
          placement: { kind: 'rack', rackId: 'rack-1', positionU: 38, face: 'front' },
          sketch: false,
        },
      ],
    },
  ],
  cables: [
    {
      id: 'cable-1',
      kind: 'copper',
      media: 'cat6',
      sheath: 'blue',
      label: 'A1-to-B3',
      lengthM: 12,
      ownership: 'ours',
      ends: [
        { portId: 'port-1', chassisId: 'chassis-1', rackId: 'rack-1' },
        { portId: 'occ-port-1', chassisId: 'occ-1', rackId: 'rack-1' },
      ],
    },
    {
      id: 'cable-2',
      kind: 'fibre',
      media: 'smf',
      sheath: 'aqua',
      label: null,
      lengthM: null,
      ownership: null,
      ends: [
        { portId: 'outlet-port-1', chassisId: 'outlet-1', rackId: null },
        { outside: true, label: 'Upstream fibre' },
      ],
    },
    {
      id: 'cable-3',
      kind: 'power',
      media: 'power',
      sheath: 'grey',
      label: null,
      lengthM: null,
      ownership: null,
      ends: [],
    },
  ],
};

describe('cableEndText — the two ends in words', () => {
  it('reads a rack chassis end as hostname · port label', () => {
    expect(cableEndText(VIEW, { portId: 'port-1', chassisId: 'chassis-1', rackId: 'rack-1' })).toBe('core-01 · 0');
  });

  it('reads a shelf occupant end as occupant label · port label', () => {
    expect(cableEndText(VIEW, { portId: 'occ-port-1', chassisId: 'occ-1', rackId: 'rack-1' })).toBe('nuc-01 · eth0');
  });

  it('reads a surface fixture end as fixture label · port label', () => {
    expect(cableEndText(VIEW, { portId: 'outlet-port-1', chassisId: 'outlet-1', rackId: null })).toBe('outlet-w1 · 1');
  });

  it('reads the outside world by its own label, not a port lookup', () => {
    expect(cableEndText(VIEW, { outside: true, label: 'Upstream fibre' })).toBe('Upstream fibre');
  });

  it('is absent, never invented, for a port this view cannot resolve', () => {
    expect(cableEndText(VIEW, { portId: 'nope', chassisId: 'nowhere', rackId: null })).toBe('—');
  });
});

describe('the cable panel\'s own change shapes', () => {
  it('setCableFieldChange carries the raw text a field holds', () => {
    expect(setCableFieldChange('cable-1', 'label', 'A1-to-B3')).toEqual({
      kind: 'cable',
      id: 'cable-1',
      field: 'label',
      value: 'A1-to-B3',
    });
  });

  it('setCableFieldChange carries a clear as null, never an empty string', () => {
    expect(setCableFieldChange('cable-1', 'length_m', null)).toEqual({
      kind: 'cable',
      id: 'cable-1',
      field: 'length_m',
      value: null,
    });
  });

  it('disconnectCableChange names only the cable — an action, not a field edit', () => {
    expect(disconnectCableChange('cable-1')).toEqual({ kind: 'cable-disconnect', id: 'cable-1' });
  });
});

describe('EditorFor — a selected cable\'s panel', () => {
  const WRITER: EditorActions = { onEdit: () => {} };

  it('returns null for a cable id this view does not carry', () => {
    expect(EditorFor({ kind: 'cable', id: 'nope' }, VIEW, WRITER)).toBeNull();
  });

  it('renders both ends in words, the label, kind and media', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'cable', id: 'cable-1' }, VIEW, WRITER) as never);
    expect(markup).toContain('A1-to-B3');
    expect(markup).toContain('core-01 · 0');
    expect(markup).toContain('nuc-01 · eth0');
    expect(markup).toContain('copper');
    expect(markup).toContain('cat6');
  });

  it('a copper cable\'s sheath selector lists the nine stock lead colours, the current one marked', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'cable', id: 'cable-1' }, VIEW, WRITER) as never);
    for (const sheath of COPPER_SHEATHS) expect(markup).toContain(sheath);
    expect((markup.match(/role="radio"/g) ?? []).length).toBe(COPPER_SHEATHS.length);
    expect(markup).toContain('aria-checked="true"');
  });

  it('a fibre cable\'s sheath selector lists the four TIA-598-C colours', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'cable', id: 'cable-2' }, VIEW, WRITER) as never);
    for (const sheath of FIBRE_SHEATHS) expect(markup).toContain(sheath);
    expect((markup.match(/role="radio"/g) ?? []).length).toBe(FIBRE_SHEATHS.length);
  });

  it('a power cable\'s sheath selector is fixed to the one grey', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'cable', id: 'cable-3' }, VIEW, WRITER) as never);
    expect((markup.match(/role="radio"/g) ?? []).length).toBe(POWER_SHEATHS.length);
    expect(POWER_SHEATHS).toEqual(['grey']);
  });

  it('renders the outside end by its own label, the far end resolved through a port', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'cable', id: 'cable-2' }, VIEW, WRITER) as never);
    expect(markup).toContain('outlet-w1 · 1');
    expect(markup).toContain('Upstream fibre');
  });

  it('renders length in metres and ownership, and a Disconnect action', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'cable', id: 'cable-1' }, VIEW, WRITER) as never);
    expect(markup).toContain('12');
    expect(markup).toContain('ours');
    expect(markup).toContain('Disconnect');
  });

  it('absent ends, length and ownership read as the shared dash, never invented', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'cable', id: 'cable-3' }, VIEW, WRITER) as never);
    expect(markup).toContain('Ends');
    expect((markup.match(/—/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('view-only (no onEdit) renders every field as text — no input, select or button', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'cable', id: 'cable-1' }, VIEW, {}) as never);
    expect(markup).not.toContain('<input');
    expect(markup).not.toContain('<select');
    expect(markup).not.toContain('<button');
    // The sheath still reads as plain text, not the swatch selector.
    expect(markup).toContain('blue');
    expect(markup).toContain('core-01 · 0');
    expect(markup).toContain('ours');
  });
});
