import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ClosetView, EditorActions } from './contract';
import { EditorFor, farEndOf } from './Editor';

// This session's brief item 2 — the selected port's own panel: the device
// and port label, connector, service, face, its cable if any with the far
// end in words and the cable's sheath swatch, two actions (Select cable,
// Go to far end), and — no cable, canDraw — Connect…. Render-to-string
// smoke tests only, the same shape `Editor.cable.test.ts`'s own file header
// gives (no DOM testing library installed, so a click is never simulated,
// only the markup a given state would produce).

const VIEW: ClosetView = {
  premisesId: 'closet-1',
  unplaced: [],
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
            {
              id: 'outlet-port-1',
              label: '1',
              connector: 'rj45',
              row: 0,
              column: 0,
              uplink: false,
              role: null,
              face: 'front',
              passThroughId: null,
              cable: { cableId: 'cable-2', farPortId: null, farChassisId: null, outsideCloset: true },
              service: 'ethernet',
            },
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
                {
                  id: 'occ-port-1',
                  label: 'eth0',
                  connector: 'rj45',
                  row: 0,
                  column: 0,
                  uplink: false,
                  role: null,
                  face: 'front',
                  passThroughId: null,
                  cable: { cableId: 'cable-1', farPortId: 'port-1', farChassisId: 'chassis-1', outsideCloset: false },
                  service: null,
                },
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
            {
              id: 'port-1',
              label: '0',
              connector: 'RJ45',
              row: 0,
              column: 0,
              role: null,
              face: 'front',
              uplink: false,
              cable: { cableId: 'cable-1', farPortId: 'occ-port-1', farChassisId: 'occ-1', outsideCloset: false },
              passThroughId: null,
              service: 'ethernet',
            },
            {
              id: 'port-2',
              label: '1',
              connector: 'RJ45',
              row: 0,
              column: 1,
              role: null,
              face: 'front',
              uplink: false,
              cable: null,
              passThroughId: null,
              service: null,
            },
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
  ],
};

describe('farEndOf — the far-end resolution', () => {
  it('finds the other end of a two-ended cable', () => {
    expect(farEndOf(VIEW, 'cable-1', 'port-1')).toEqual({ portId: 'occ-port-1', chassisId: 'occ-1', rackId: 'rack-1' });
    expect(farEndOf(VIEW, 'cable-1', 'occ-port-1')).toEqual({ portId: 'port-1', chassisId: 'chassis-1', rackId: 'rack-1' });
  });

  it('finds the outside end by its own label, not a port lookup', () => {
    expect(farEndOf(VIEW, 'cable-2', 'outlet-port-1')).toEqual({ outside: true, label: 'Upstream fibre' });
  });

  it('is undefined, never invented, for a cable this view does not carry', () => {
    expect(farEndOf(VIEW, 'nope', 'port-1')).toBeUndefined();
  });
});

const WRITER: EditorActions = { onEdit: () => {}, onSelect: () => {} };
const READER: EditorActions = {};

describe('EditorFor — a selected port\'s panel', () => {
  it('returns null for a port id this view does not carry', () => {
    expect(EditorFor({ kind: 'port', id: 'nope' }, VIEW, WRITER)).toBeNull();
  });

  it('renders the device and port label, connector, service and face', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'port', id: 'port-1' }, VIEW, WRITER) as never);
    expect(markup).toContain('core-01'); // the device
    expect(markup).toContain('drawing-editor__title'); // the port's own label sits here
    expect(markup).toContain('RJ45'); // connector
    expect(markup).toContain('ethernet'); // service
    expect(markup).toContain('front'); // face
  });

  it('an unset service reads as the shared dash, never invented', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'port', id: 'occ-port-1' }, VIEW, WRITER) as never);
    expect(markup).toContain('—');
  });

  it('a cabled port shows the far end in words and the cable\'s sheath swatch', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'port', id: 'port-1' }, VIEW, WRITER) as never);
    expect(markup).toContain('nuc-01 · eth0'); // the far end, in words
    expect(markup).toContain('var(--sheath-blue)'); // the swatch, cable-1's own sheath
    expect(markup).toContain('Select cable');
    expect(markup).toContain('Go to far end');
  });

  it('a cabled port with an outside far end shows the outside label, and no Go to far end (nothing to go to)', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'port', id: 'outlet-port-1' }, VIEW, WRITER) as never);
    expect(markup).toContain('Upstream fibre');
    expect(markup).toContain('Select cable');
    expect(markup).not.toContain('Go to far end');
  });

  it('a port with no cable says so, and offers Connect… for a writer', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'port', id: 'port-2' }, VIEW, WRITER) as never);
    expect(markup).toContain('Not cabled.');
    expect(markup).toContain('Connect…');
  });

  it('a reader sees "Not cabled." but no Connect… — nothing to start a drag with', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'port', id: 'port-2' }, VIEW, READER) as never);
    expect(markup).toContain('Not cabled.');
    expect(markup).not.toContain('Connect…');
    expect(markup).not.toContain('<button');
  });

  it('a reader still sees a cabled port\'s far end and swatch, but no actions (no onSelect)', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'port', id: 'port-1' }, VIEW, READER) as never);
    expect(markup).toContain('nuc-01 · eth0');
    expect(markup).not.toContain('Select cable');
    expect(markup).not.toContain('Go to far end');
  });

  it('renders a port on a shelf occupant with the same fields', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'port', id: 'occ-port-1' }, VIEW, WRITER) as never);
    expect(markup).toContain('nuc-01');
    expect(markup).toContain('core-01 · 0'); // its own far end
  });

  it('renders a port on a surface fixture with the same fields', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'port', id: 'outlet-port-1' }, VIEW, WRITER) as never);
    expect(markup).toContain('outlet-w1');
    expect(markup).toContain('ethernet');
  });
});
