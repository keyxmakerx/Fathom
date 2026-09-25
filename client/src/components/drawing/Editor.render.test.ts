import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ClosetView, EditorActions } from './contract';
import {
  EditorFor,
  addSketchPortChange,
  addSketchPortRangeChange,
  createShelfChange,
  createSurfaceChange,
  duplicateDeviceChange,
  moveToRackChange,
  moveToShelfChange,
  moveToSurfaceChange,
  removeSketchPortChange,
} from './Editor';

// Render-to-string smoke tests only, per the Popover precedent
// (`components/shell/Popover.render.test.ts`): no DOM testing library is
// installed, so interaction (the click-to-select, click-to-edit state
// machine `Editor.tsx`'s `EditableValue` holds) is not exercised, only
// markup shape — the idle state's rendered value, placeholder and marks.

const NOOP_ACTIONS: EditorActions = { onEdit: () => {} };

const VIEW: ClosetView = {
  premisesId: 'closet-1',
  cables: [],
  rows: [],
  surfaces: [],
  racks: [
    {
      id: 'rack-1',
      label: 'A-04',
      heightU: 42,
      unitNumbering: 'bottom-up',
      row: null,
      bay: null,
      freeRuns: [{ fromU: 1, toU: 10 }],
      shelves: [],
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
              cable: null,
              passThroughId: null,
            },
          ],
          role: 'switch',
          managementAddress: '10.10.0.2',
          serial: 'SN-0042',
          psuInlets: [],
          singleFed: false,
          oneFitted: false,
          placement: { kind: 'rack', rackId: 'rack-1', positionU: 38, face: 'front' },
          sketch: false,
        },
      ],
    },
  ],
};

const BARE_VIEW: ClosetView = {
  premisesId: 'closet-1',
  cables: [],
  rows: [],
  surfaces: [],
  racks: [
    {
      id: 'rack-1',
      label: 'A-04',
      heightU: 42,
      unitNumbering: 'bottom-up',
      row: null,
      bay: null,
      freeRuns: [{ fromU: 1, toU: 10 }],
      shelves: [],
      chassis: [
        {
          id: 'chassis-1',
          deviceId: 'device-1',
          hostname: '',
          model: 'EX4300-48P',
          vendor: 'juniper',
          positionU: 38,
          heightU: 1,
          face: 'front',
          ports: [],
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
};

const SKETCH_VIEW: ClosetView = {
  premisesId: 'closet-1',
  cables: [],
  rows: [],
  surfaces: [
    { id: 'surface-1', label: 'West wall', form: 'wall', widthMm: 3000, heightMm: 2400, fixtures: [] },
  ],
  racks: [
    {
      id: 'rack-1',
      label: 'A-04',
      heightU: 42,
      unitNumbering: 'bottom-up',
      row: null,
      bay: null,
      freeRuns: [{ fromU: 1, toU: 42 }],
      shelves: [{ id: 'shelf-1', label: 'shelf-a01', positionU: 20, heightU: 2, occupants: [] }],
      chassis: [
        {
          id: 'chassis-2',
          deviceId: 'device-2',
          hostname: 'nuc-01',
          model: '',
          vendor: '',
          positionU: 30,
          heightU: 1,
          face: 'front',
          ports: [
            {
              id: 'port-2',
              label: 'eth0',
              connector: 'rj45',
              row: 0,
              column: 0,
              role: null,
              face: 'front',
              uplink: false,
              cable: null,
              passThroughId: null,
            },
          ],
          role: null,
          managementAddress: null,
          serial: null,
          psuInlets: [],
          singleFed: false,
          oneFitted: false,
          placement: { kind: 'rack', rackId: 'rack-1', positionU: 30, face: 'front' },
          sketch: true,
        },
      ],
    },
  ],
};

// ADR-0051 §1/§2, this session's brief item 3 — a shelf occupant and a
// surface fixture (a board included), each with its own port, so
// `EditorFor`'s new `'occupant'`/`'fixture'` selection kinds — and a port
// selected on either place — have something real to render.
const PLACES_VIEW: ClosetView = {
  premisesId: 'closet-1',
  cables: [],
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
        {
          id: 'board-1',
          kind: 'passive',
          label: 'BOARD-W1',
          model: 'plywood 1200x900',
          form: 'board',
          xMm: 150,
          yMm: 900,
          ports: [],
          psuInlets: [],
          fixtures: [
            {
              id: 'nid-1',
              kind: 'passive',
              label: 'nid-01',
              model: 'carrier demarc',
              form: null,
              xMm: 100,
              yMm: 50,
              ports: [
                { id: 'nid-port-1', label: 'demarc', connector: 'lc', row: 0, column: 0, uplink: false, role: null, face: 'front', passThroughId: null, cable: null },
              ],
              psuInlets: [],
              fixtures: [],
            },
          ],
        },
      ],
    },
  ],
  racks: [
    {
      id: 'rack-1',
      label: 'A-01',
      heightU: 42,
      unitNumbering: 'bottom-up',
      row: null,
      bay: null,
      freeRuns: [{ fromU: 1, toU: 42 }],
      shelves: [
        {
          id: 'shelf-1',
          label: 'shelf-a01',
          positionU: 20,
          heightU: 2,
          occupants: [
            {
              id: 'nuc-1',
              kind: 'chassis',
              label: 'nuc-01',
              model: null,
              slot: 1,
              sketch: true,
              ports: [
                { id: 'nuc-port-1', label: 'eth0', connector: 'rj45', row: 0, column: 0, uplink: false, role: null, face: 'front', passThroughId: null, cable: null },
              ],
            },
          ],
        },
      ],
      chassis: [],
    },
  ],
};

describe('EditorFor', () => {
  it('returns null for no selection', () => {
    expect(EditorFor(null, VIEW, NOOP_ACTIONS)).toBeNull();
  });

  it('returns null for a selection this view does not carry', () => {
    expect(EditorFor({ kind: 'rack', id: 'nope' }, VIEW, NOOP_ACTIONS)).toBeNull();
  });

  it('renders the rack fields', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'rack', id: 'rack-1' }, VIEW, NOOP_ACTIONS) as never);
    expect(markup).toContain('A-04');
    expect(markup).toContain('42U');
    expect(markup).toContain('1 of 42U');
  });

  it('renders the chassis fields, honest that cable state is absent', () => {
    const markup = renderToStaticMarkup(
      EditorFor({ kind: 'chassis', id: 'chassis-1' }, VIEW, NOOP_ACTIONS) as never,
    );
    expect(markup).toContain('core-01');
    expect(markup).toContain('EX4300-48P');
    expect(markup).toContain('U38');
    expect(markup).toContain('— of 1 cabled');
  });

  it('renders the editable role, management address and serial, each marked stored as typed', () => {
    const markup = renderToStaticMarkup(
      EditorFor({ kind: 'chassis', id: 'chassis-1' }, VIEW, NOOP_ACTIONS) as never,
    );
    expect(markup).toContain('switch');
    expect(markup).toContain('10.10.0.2');
    expect(markup).toContain('SN-0042');
    expect(markup).toContain('Stored as typed.');
    expect(markup).toContain(
      'Fathom does not redact what you type, only what you paste, so it is saved and exported exactly as written.',
    );
  });

  it('renders absence as absence — no invented values, no typed mark', () => {
    const markup = renderToStaticMarkup(
      EditorFor({ kind: 'chassis', id: 'chassis-1' }, BARE_VIEW, NOOP_ACTIONS) as never,
    );
    expect(markup).toContain('unnamed');
    expect(markup).not.toContain('Stored as typed.');
    // Absent fields fall back to the shared dash mark — present at least
    // once per absent field (role, mgmt address, serial), never a blank.
    expect((markup.match(/—/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('renders the port fields', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'port', id: 'port-1' }, VIEW, NOOP_ACTIONS) as never);
    expect(markup).toContain('RJ45');
    expect(markup).toContain('core-01');
  });

  // ADR-0051 §1, this session's brief — "PLACED ON", a sketch's typed
  // ports, and a rack's "+ add a shelf".

  it('renders the rack fields with "+ add a shelf"', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'rack', id: 'rack-1' }, VIEW, NOOP_ACTIONS) as never);
    expect(markup).toContain('+ add a shelf');
  });

  it('renders "PLACED ON" with Rack marked current for a rack-mounted chassis', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'chassis', id: 'chassis-1' }, VIEW, NOOP_ACTIONS) as never);
    expect(markup).toContain('Placed on');
    expect(markup).toContain('Rack');
    expect(markup).toContain('Shelf');
    expect(markup).toContain('Surface');
  });

  it('renders "Duplicate" on a rack-mounted chassis\'s own panel for a writer, absent for a reader', () => {
    const writerMarkup = renderToStaticMarkup(EditorFor({ kind: 'chassis', id: 'chassis-1' }, VIEW, NOOP_ACTIONS) as never);
    expect(writerMarkup).toContain('Duplicate');

    const readerMarkup = renderToStaticMarkup(EditorFor({ kind: 'chassis', id: 'chassis-1' }, VIEW, {}) as never);
    expect(readerMarkup).not.toContain('Duplicate');
  });

  it('renders a sketch chassis with "no catalogue entry", its typed ports and "+ add a port" — a catalogued chassis shows neither', () => {
    const sketchMarkup = renderToStaticMarkup(
      EditorFor({ kind: 'chassis', id: 'chassis-2' }, SKETCH_VIEW, NOOP_ACTIONS) as never,
    );
    expect(sketchMarkup).toContain('No catalogue entry.');
    expect(sketchMarkup).toContain('eth0');
    expect(sketchMarkup).toContain('typed');
    expect(sketchMarkup).toContain('+ add a port');

    const catalogued = renderToStaticMarkup(EditorFor({ kind: 'chassis', id: 'chassis-1' }, VIEW, NOOP_ACTIONS) as never);
    expect(catalogued).not.toContain('No catalogue entry.');
    expect(catalogued).not.toContain('+ add a port');
  });

  // ADR-0051 §1/§2, this session's brief item 3 — occupant and fixture
  // selection kinds.

  it('returns null for an occupant/fixture id this view does not carry', () => {
    expect(EditorFor({ kind: 'occupant', id: 'nope' }, PLACES_VIEW, NOOP_ACTIONS)).toBeNull();
    expect(EditorFor({ kind: 'fixture', id: 'nope' }, PLACES_VIEW, NOOP_ACTIONS)).toBeNull();
  });

  it('renders a shelf occupant: label, sketch mark, shelf/slot, typed ports and "+ add a port", and PLACED ON', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'occupant', id: 'nuc-1' }, PLACES_VIEW, NOOP_ACTIONS) as never);
    expect(markup).toContain('nuc-01');
    expect(markup).toContain('No catalogue entry.');
    expect(markup).toContain('shelf-a01');
    expect(markup).toContain('A-01');
    expect(markup).toContain('eth0');
    expect(markup).toContain('+ add a port');
    expect(markup).toContain('Placed on');
    expect(markup).toContain('Shelf');
  });

  it('renders a surface fixture straight on the wall: label, position, ports, and PLACED ON', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'fixture', id: 'outlet-1' }, PLACES_VIEW, NOOP_ACTIONS) as never);
    expect(markup).toContain('outlet-w1');
    expect(markup).toContain('West wall');
    expect(markup).toContain('300mm, 1200mm');
    expect(markup).toContain('Placed on');
    expect(markup).toContain('Surface');
  });

  it('renders a fixture nested under a board, and the board fixture itself', () => {
    const nested = renderToStaticMarkup(EditorFor({ kind: 'fixture', id: 'nid-1' }, PLACES_VIEW, NOOP_ACTIONS) as never);
    expect(nested).toContain('nid-01');
    expect(nested).toContain('carrier demarc');

    const board = renderToStaticMarkup(EditorFor({ kind: 'fixture', id: 'board-1' }, PLACES_VIEW, NOOP_ACTIONS) as never);
    expect(board).toContain('BOARD-W1');
    expect(board).toContain('board');
  });

  it('renders a port on a shelf occupant', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'port', id: 'nuc-port-1' }, PLACES_VIEW, NOOP_ACTIONS) as never);
    expect(markup).toContain('eth0');
    expect(markup).toContain('nuc-01');
    expect(markup).toContain('shelf-a01');
  });

  it('renders a port on a surface fixture', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'port', id: 'outlet-port-1' }, PLACES_VIEW, NOOP_ACTIONS) as never);
    expect(markup).toContain('outlet-w1');
    expect(markup).toContain('West wall');
  });

  // This session's brief items 1/4 — a shelf itself: its own editable
  // name, and its occupants listed by slot, each a link that selects the
  // occupant.
  it('returns null for a shelf id this view does not carry', () => {
    expect(EditorFor({ kind: 'shelf', id: 'nope' }, PLACES_VIEW, NOOP_ACTIONS)).toBeNull();
  });

  it('renders a shelf: its own name, rack/unit/height, and its occupants by slot', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'shelf', id: 'shelf-1' }, PLACES_VIEW, NOOP_ACTIONS) as never);
    expect(markup).toContain('shelf-a01');
    expect(markup).toContain('A-01');
    expect(markup).toContain('U20');
    expect(markup).toContain('2U');
    expect(markup).toContain('Occupants');
    expect(markup).toContain('nuc-01');
  });

  it('an occupant link is a real link only when the caller supplies onSelect', () => {
    const noLink = renderToStaticMarkup(EditorFor({ kind: 'shelf', id: 'shelf-1' }, PLACES_VIEW, NOOP_ACTIONS) as never);
    expect(noLink).not.toContain('<button');

    const withSelect: EditorActions = { onEdit: () => {}, onSelect: () => {} };
    const withLink = renderToStaticMarkup(EditorFor({ kind: 'shelf', id: 'shelf-1' }, PLACES_VIEW, withSelect) as never);
    expect(withLink).toContain('<button');
    expect(withLink).toContain('nuc-01');
  });

  // This session's brief item 2 — a chicken-and-egg fix: a device with no
  // catalogue model and ZERO ports (exactly what `createSketchDevice`
  // mints, before its first port is typed) must still show "+ add a port",
  // not just one that already carries a port (`chassis.sketch`'s own
  // ports.length > 0 gate, `document/view.ts`, is right for the box on the
  // plate but wrong for this).
  it('a chassis with no model and zero ports still shows "+ add a port"', () => {
    const view: ClosetView = {
      ...VIEW,
      racks: [
        {
          ...VIEW.racks[0],
          chassis: [
            {
              ...VIEW.racks[0].chassis[0],
              id: 'chassis-3',
              model: '',
              vendor: '',
              ports: [],
              sketch: false,
            },
          ],
        },
      ],
    };
    const markup = renderToStaticMarkup(EditorFor({ kind: 'chassis', id: 'chassis-3' }, view, NOOP_ACTIONS) as never);
    expect(markup).toContain('No catalogue entry.');
    expect(markup).toContain('+ add a port');
  });

  it('a shelf occupant with no model and zero ports still shows "+ add a port"', () => {
    const view: ClosetView = {
      ...PLACES_VIEW,
      racks: [
        {
          ...PLACES_VIEW.racks[0],
          shelves: [
            {
              ...PLACES_VIEW.racks[0].shelves[0],
              occupants: [{ ...PLACES_VIEW.racks[0].shelves[0].occupants[0], id: 'nuc-2', ports: [], sketch: false }],
            },
          ],
        },
      ],
    };
    const markup = renderToStaticMarkup(EditorFor({ kind: 'occupant', id: 'nuc-2' }, view, NOOP_ACTIONS) as never);
    expect(markup).toContain('No catalogue entry.');
    expect(markup).toContain('+ add a port');
  });
});

// The pure change-builders `Editor.tsx` uses internally (module header:
// this project's tests have no DOM environment to drive a click through,
// so the shape of what a click WOULD raise is tested directly here, the
// same way `RacksPlace.edit.test.ts` tests `refusalFor` — the pure half of
// what a click leads to — rather than simulating one).
describe('the PLACED ON / sketch-port / add-shelf / add-surface change shapes', () => {
  it('moveToRackChange builds a rack Placement', () => {
    expect(moveToRackChange('chassis:1', 'rack:2', 12)).toEqual({
      kind: 'move-placement',
      itemId: 'chassis:1',
      placement: { kind: 'rack', rackId: 'rack:2', positionU: 12, face: 'front' },
    });
  });

  it('moveToShelfChange builds a shelf Placement', () => {
    expect(moveToShelfChange('chassis:1', 'passive-node:shelf', 2)).toEqual({
      kind: 'move-placement',
      itemId: 'chassis:1',
      placement: { kind: 'shelf', shelfId: 'passive-node:shelf', slot: 2 },
    });
  });

  it('moveToSurfaceChange builds a surface Placement for a surface target', () => {
    expect(moveToSurfaceChange('chassis:1', { id: 'surface:1', kind: 'surface' }, 100, 200)).toEqual({
      kind: 'move-placement',
      itemId: 'chassis:1',
      placement: { kind: 'surface', surfaceId: 'surface:1', xMm: 100, yMm: 200 },
    });
  });

  it('moveToSurfaceChange builds a board Placement for a board target, position optional', () => {
    expect(moveToSurfaceChange('chassis:1', { id: 'passive-node:board', kind: 'board' }, null, null)).toEqual({
      kind: 'move-placement',
      itemId: 'chassis:1',
      placement: { kind: 'board', boardId: 'passive-node:board', xMm: null, yMm: null },
    });
  });

  it('addSketchPortChange carries a null service when left blank', () => {
    expect(addSketchPortChange('chassis:1', 'eth0', 'rj45', null, 'front')).toEqual({
      kind: 'add-sketch-port',
      chassisId: 'chassis:1',
      label: 'eth0',
      connector: 'rj45',
      service: null,
      face: 'front',
    });
  });

  it('removeSketchPortChange names the chassis and the port', () => {
    expect(removeSketchPortChange('chassis:1', 'physical-port:2')).toEqual({
      kind: 'remove-sketch-port',
      chassisId: 'chassis:1',
      portId: 'physical-port:2',
    });
  });

  it('addSketchPortRangeChange carries the prefix, first, last and a null service when left blank', () => {
    expect(addSketchPortRangeChange('chassis:1', 'ge-0/0/', 0, 47, 'rj45', null, 'front')).toEqual({
      kind: 'add-sketch-port-range',
      chassisId: 'chassis:1',
      labelPrefix: 'ge-0/0/',
      first: 0,
      last: 47,
      connector: 'rj45',
      service: null,
      face: 'front',
    });
  });

  it('duplicateDeviceChange names the chassis', () => {
    expect(duplicateDeviceChange('chassis:1')).toEqual({ kind: 'duplicate-device', chassisId: 'chassis:1' });
  });

  it('createShelfChange carries a null model when none was chosen', () => {
    expect(createShelfChange('rack:1', 20, 'Mini PC shelf', null)).toEqual({
      kind: 'create-shelf',
      rackId: 'rack:1',
      positionU: 20,
      label: 'Mini PC shelf',
      model: null,
    });
  });

  it('createShelfChange carries the chosen catalogue model', () => {
    expect(createShelfChange('rack:1', 20, 'Mini PC shelf', { vendor: 'acme', model: 'shelf-1u' })).toEqual({
      kind: 'create-shelf',
      rackId: 'rack:1',
      positionU: 20,
      label: 'Mini PC shelf',
      model: { vendor: 'acme', model: 'shelf-1u' },
    });
  });

  it('createSurfaceChange carries the raw form text unvalidated — the caller validates it', () => {
    expect(createSurfaceChange('premises:1', 'West wall', 'wall')).toEqual({
      kind: 'create-surface',
      premisesId: 'premises:1',
      label: 'West wall',
      form: 'wall',
    });
  });
});
