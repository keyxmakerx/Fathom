import { describe, expect, it } from 'vitest';

import type { ClosetView } from './contract';
import type { FixtureView, OccupantView, ShelfView, SurfaceView } from '../../document/view';
import {
  findChassis,
  findPort,
  findRack,
  findShelfOccupantPort,
  findSurfaceFixturePort,
  locatePort,
} from './lookup';

const SHELF_OCCUPANT: OccupantView = {
  id: 'occupant-1',
  kind: 'chassis',
  label: 'nuc-01',
  model: null,
  slot: 1,
  sketch: true,
  ports: [
    {
      id: 'occupant-port-1',
      label: 'eth0',
      connector: 'RJ45',
      row: 0,
      column: 0,
      uplink: false,
      role: null,
      face: 'front',
      passThroughId: null,
      cable: null,
    },
  ],
};

const SHELF: ShelfView = {
  id: 'shelf-1',
  label: 'shelf-a01',
  positionU: 20,
  heightU: 2,
  occupants: [SHELF_OCCUPANT],
};

const OUTLET_FIXTURE: FixtureView = {
  id: 'outlet-w1',
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
      connector: 'RJ45',
      row: 0,
      column: 0,
      uplink: false,
      role: null,
      face: 'front',
      passThroughId: null,
      cable: null,
    },
  ],
  psuInlets: [],
  fixtures: [],
};

const NID_FIXTURE: FixtureView = {
  id: 'nid-01',
  kind: 'passive',
  label: 'nid-01',
  model: null,
  form: null,
  xMm: 100,
  yMm: 50,
  ports: [
    {
      id: 'nid-port-1',
      label: 'demarc',
      connector: 'LC',
      row: 0,
      column: 0,
      uplink: false,
      role: null,
      face: 'front',
      passThroughId: null,
      cable: null,
    },
  ],
  psuInlets: [],
  fixtures: [],
};

const BOARD_FIXTURE: FixtureView = {
  id: 'board-w1',
  kind: 'passive',
  label: 'BOARD-W1',
  model: 'plywood 1200x900',
  form: 'board',
  xMm: 150,
  yMm: 900,
  ports: [],
  psuInlets: [],
  fixtures: [NID_FIXTURE],
};

const UPS_FIXTURE: FixtureView = {
  id: 'ups-01',
  kind: 'chassis',
  label: 'ups-01',
  model: '3 kVA tower',
  form: null,
  xMm: 800,
  yMm: null,
  ports: [
    {
      id: 'ups-outlet-1',
      label: '1',
      connector: 'nema515r',
      row: 0,
      column: 0,
      uplink: false,
      role: null,
      face: 'front',
      passThroughId: null,
      cable: null,
    },
  ],
  psuInlets: [
    {
      id: 'ups-inlet-1',
      label: 'inlet',
      connector: 'nema515p',
      row: 0,
      column: 0,
      uplink: false,
      role: null,
      face: 'front',
      passThroughId: null,
      cable: null,
      slot: 'inlet',
      hotSwap: false,
      fitted: true,
      supplyId: null,
      serial: null,
      model: null,
      position: { row: 'single', column: 0 },
    },
  ],
  fixtures: [],
};

const WEST_WALL: SurfaceView = {
  id: 'wall-west',
  label: 'west wall',
  form: 'wall',
  widthMm: 2400,
  heightMm: 1800,
  fixtures: [OUTLET_FIXTURE, BOARD_FIXTURE],
};

const FLOOR: SurfaceView = {
  id: 'floor-1',
  label: 'floor',
  form: 'floor',
  widthMm: null,
  heightMm: null,
  fixtures: [UPS_FIXTURE],
};

const VIEW: ClosetView = {
  premisesId: 'closet-1',
  cables: [],
  rows: [],
  surfaces: [WEST_WALL, FLOOR],
  racks: [
    {
      id: 'rack-1',
      label: 'A-04',
      heightU: 42,
      unitNumbering: 'bottom-up',
      freeRuns: [],
      row: null,
      bay: null,
      shelves: [SHELF],
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
              uplink: false,
              cable: null,
              face: 'front',
              passThroughId: null,
            },
            {
              id: 'port-2',
              label: 'xe-0',
              connector: 'SFP+',
              row: 0,
              column: 1,
              role: null,
              uplink: true,
              cable: null,
              face: 'front',
              passThroughId: null,
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
};

describe('findRack', () => {
  it('finds a rack by id', () => {
    expect(findRack(VIEW, 'rack-1')?.label).toBe('A-04');
  });

  it('returns undefined for an id this view does not carry', () => {
    expect(findRack(VIEW, 'nope')).toBeUndefined();
  });
});

describe('findChassis', () => {
  it('finds a chassis and the rack it sits in', () => {
    const found = findChassis(VIEW, 'chassis-1');
    expect(found?.rack.id).toBe('rack-1');
    expect(found?.chassis.hostname).toBe('core-01');
  });

  it('returns undefined for an id this view does not carry', () => {
    expect(findChassis(VIEW, 'nope')).toBeUndefined();
  });
});

describe('findPort', () => {
  it('finds a port and its chassis and rack', () => {
    const found = findPort(VIEW, 'port-2');
    expect(found?.rack.id).toBe('rack-1');
    expect(found?.chassis.id).toBe('chassis-1');
    expect(found?.port.uplink).toBe(true);
  });

  it('returns undefined for an id this view does not carry', () => {
    expect(findPort(VIEW, 'nope')).toBeUndefined();
  });

  it('does not find a shelf occupant\'s port or a surface fixture\'s — a rack chassis\'s own faceplate only', () => {
    expect(findPort(VIEW, 'occupant-port-1')).toBeUndefined();
    expect(findPort(VIEW, 'outlet-port-1')).toBeUndefined();
  });
});

describe('findShelfOccupantPort — ADR-0051 §1', () => {
  it('finds a port on a shelf occupant, and the rack/shelf/occupant it sits in', () => {
    const found = findShelfOccupantPort(VIEW, 'occupant-port-1');
    expect(found?.rack.id).toBe('rack-1');
    expect(found?.shelf.id).toBe('shelf-1');
    expect(found?.occupant.id).toBe('occupant-1');
    expect(found?.port.label).toBe('eth0');
  });

  it('returns undefined for an id this view does not carry', () => {
    expect(findShelfOccupantPort(VIEW, 'nope')).toBeUndefined();
  });

  it('does not find a rack chassis\'s own faceplate port', () => {
    expect(findShelfOccupantPort(VIEW, 'port-1')).toBeUndefined();
  });
});

describe('findSurfaceFixturePort — ADR-0051 §1', () => {
  it('finds a port on a fixture fixed straight to a surface', () => {
    const found = findSurfaceFixturePort(VIEW, 'outlet-port-1');
    expect(found?.surface.id).toBe('wall-west');
    expect(found?.fixture.id).toBe('outlet-w1');
    expect(found?.isPsuInlet).toBe(false);
  });

  it('finds a port on a fixture nested inside a board — "a board carries its own fixtures"', () => {
    const found = findSurfaceFixturePort(VIEW, 'nid-port-1');
    expect(found?.surface.id).toBe('wall-west');
    expect(found?.fixture.id).toBe('nid-01');
  });

  it('finds a floor fixture\'s own PSU inlet, distinct from its ordinary ports', () => {
    const outlet = findSurfaceFixturePort(VIEW, 'ups-outlet-1');
    expect(outlet?.isPsuInlet).toBe(false);
    const inlet = findSurfaceFixturePort(VIEW, 'ups-inlet-1');
    expect(inlet?.surface.id).toBe('floor-1');
    expect(inlet?.isPsuInlet).toBe(true);
  });

  it('returns undefined for an id this view does not carry', () => {
    expect(findSurfaceFixturePort(VIEW, 'nope')).toBeUndefined();
  });
});

describe('locatePort — one entry point for a port anywhere this closet draws one', () => {
  it('resolves a rack chassis port as place: chassis', () => {
    expect(locatePort(VIEW, 'port-1')?.place).toBe('chassis');
  });

  it('resolves a shelf occupant port as place: shelf', () => {
    expect(locatePort(VIEW, 'occupant-port-1')?.place).toBe('shelf');
  });

  it('resolves a surface fixture port as place: fixture', () => {
    expect(locatePort(VIEW, 'outlet-port-1')?.place).toBe('fixture');
  });

  it('resolves a nested board fixture port as place: fixture', () => {
    expect(locatePort(VIEW, 'nid-port-1')?.place).toBe('fixture');
  });

  it('returns undefined for an id this view does not carry anywhere', () => {
    expect(locatePort(VIEW, 'nope')).toBeUndefined();
  });
});
