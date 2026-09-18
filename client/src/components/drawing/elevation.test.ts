import { describe, expect, it } from 'vitest';

import type { ChassisView, InletView, PortView } from './contract';
import type { OccupantView, ShelfView } from '../../document/view';
import {
  faceplateItem,
  faceplateItems,
  powerLeadHandle,
  shelfOccupantFaceplateItem,
  shelfOccupantFaceplateItems,
  visibleFaceOf,
} from './elevation';
import type { CameraStop } from './geometry';

function port(overrides: Partial<PortView> & Pick<PortView, 'id' | 'face'>): PortView {
  return {
    label: overrides.id,
    connector: 'rj45',
    row: 0,
    column: 0,
    uplink: false,
    role: null,
    cable: null,
    passThroughId: null,
    ...overrides,
  };
}

function occupant(overrides: Partial<OccupantView> & Pick<OccupantView, 'id'>): OccupantView {
  return {
    kind: 'chassis',
    label: overrides.id,
    model: null,
    slot: 1,
    ports: [],
    sketch: false,
    ...overrides,
  };
}

function shelf(overrides: Partial<ShelfView> & Pick<ShelfView, 'id'>): ShelfView {
  return { label: overrides.id, positionU: 20, heightU: 2, occupants: [], ...overrides };
}

function inlet(overrides: Partial<InletView> & Pick<InletView, 'id' | 'face'>): InletView {
  return {
    label: overrides.id,
    connector: 'c14',
    role: null,
    serial: null,
    model: null,
    row: 0,
    column: 0,
    uplink: false,
    cable: null,
    passThroughId: null,
    slot: 'PSU 0',
    hotSwap: true,
    fitted: true,
    supplyId: null,
    position: { row: 'single', column: 0 },
    ...overrides,
  };
}

function chassis(overrides: Partial<ChassisView> & Pick<ChassisView, 'id' | 'face'>): ChassisView {
  return {
    deviceId: `${overrides.id}-device`,
    hostname: overrides.id,
    model: 'MODEL',
    vendor: 'vendor',
    positionU: 1,
    heightU: 1,
    role: null,
    managementAddress: null,
    serial: null,
    psuInlets: [],
    singleFed: false,
    oneFitted: false,
    ports: [],
    placement: { kind: 'rack', rackId: 'rack-1', positionU: 1, face: 'front' },
    sketch: false,
    ...overrides,
  };
}

describe('visibleFaceOf: the elevation rule (ADR-0050 §1)', () => {
  it('a front-mounted chassis shows its front faceplate from the front elevation', () => {
    expect(visibleFaceOf('front', 'front')).toBe('front');
  });
  it('a front-mounted chassis shows its rear faceplate from the rear elevation', () => {
    expect(visibleFaceOf('front', 'rear')).toBe('rear');
  });
  it('a rear-mounted chassis shows its front faceplate from the rear elevation', () => {
    expect(visibleFaceOf('rear', 'rear')).toBe('front');
  });
  it('a rear-mounted chassis shows its rear faceplate from the front elevation', () => {
    expect(visibleFaceOf('rear', 'front')).toBe('rear');
  });
});

describe('faceplateItem: which ports and inlets draw', () => {
  it('keeps only the ports tagged with the visible face', () => {
    const c = chassis({
      id: 'sw-1',
      face: 'front',
      ports: [port({ id: 'p-front', face: 'front' }), port({ id: 'p-rear', face: 'rear' })],
    });
    expect(faceplateItem(c, 'front').ports.map((p) => p.id)).toEqual(['p-front']);
    expect(faceplateItem(c, 'rear').ports.map((p) => p.id)).toEqual(['p-rear']);
  });

  it('keeps only the inlets tagged with the visible face', () => {
    const c = chassis({
      id: 'fw-1',
      face: 'front',
      psuInlets: [inlet({ id: 'psu-rear', face: 'rear' })],
    });
    expect(faceplateItem(c, 'front').inlets).toEqual([]);
    expect(faceplateItem(c, 'rear').inlets.map((i) => i.id)).toEqual(['psu-rear']);
  });

  it('the plain-plate case: no ports and no inlets on that face draws as a bare name, never nothing', () => {
    const c = chassis({
      id: 'panel-1',
      face: 'front',
      ports: [port({ id: 'p-front', face: 'front' })],
    });
    const rear = faceplateItem(c, 'rear');
    expect(rear.ports).toEqual([]);
    expect(rear.inlets).toEqual([]);
    expect(rear.plainPlate).toBe(true);
    expect(faceplateItem(c, 'front').plainPlate).toBe(false);
  });

  it('a chassis with something on both faces is never a plain plate on either', () => {
    const c = chassis({
      id: 'both',
      face: 'front',
      ports: [port({ id: 'p-front', face: 'front' })],
      psuInlets: [inlet({ id: 'psu-rear', face: 'rear' })],
    });
    expect(faceplateItem(c, 'front').plainPlate).toBe(false);
    expect(faceplateItem(c, 'rear').plainPlate).toBe(false);
  });
});

describe('faceplateItems: every mounted chassis draws at every elevation', () => {
  it('a rear-mounted chassis is never dropped from the front elevation — it draws as its own (rear) faceplate, or a plain plate', () => {
    const front = chassis({ id: 'front-1', face: 'front', ports: [port({ id: 'p1', face: 'front' })] });
    const rear = chassis({ id: 'rear-1', face: 'rear' }); // no ports on either face: always a plain plate
    const items = faceplateItems([front, rear], 'front');
    expect(items.map((i) => i.chassis.id)).toEqual(['front-1', 'rear-1']);
    expect(items[1].plainPlate).toBe(true);
  });
});

describe('powerLeadHandle: where a PSU inlet lead ends — s6f #1', () => {
  const stops: CameraStop[] = ['closet', 'rack', 'faceplate'];

  it('the front elevation always ends on the rail hexagon, at every camera stop', () => {
    for (const stop of stops) {
      expect(powerLeadHandle('front', stop)).toBe('rail');
    }
  });

  it('the rear elevation ends on the plate\'s stable anchor at the closet stop, never the strip\'s own inlet handle', () => {
    expect(powerLeadHandle('rear', 'closet')).toBe('anchor');
  });

  it('the rear elevation ends on the plate\'s stable anchor at the rack stop too', () => {
    expect(powerLeadHandle('rear', 'rack')).toBe('anchor');
  });

  it('the rear elevation ends on the inlet itself only at the faceplate stop', () => {
    expect(powerLeadHandle('rear', 'faceplate')).toBe('inlet');
  });

  it('a cable must draw at every stop: every (elevation, stop) pair resolves to a handle that actually exists', () => {
    const elevations: Array<'front' | 'rear'> = ['front', 'rear'];
    for (const elevation of elevations) {
      for (const stop of stops) {
        expect(['rail', 'anchor', 'inlet']).toContain(powerLeadHandle(elevation, stop));
      }
    }
  });
});

describe('shelfOccupantFaceplateItem: a shelf occupant shows front and rear by the same rule as a chassis', () => {
  it('keeps only the ports tagged with the visible face — front elevation', () => {
    const o = occupant({
      id: 'nuc-01',
      ports: [port({ id: 'eth0', face: 'front' }), port({ id: 'psu', face: 'rear' })],
    });
    const item = shelfOccupantFaceplateItem(o, 'front');
    expect(item.visibleFace).toBe('front');
    expect(item.ports.map((p) => p.id)).toEqual(['eth0']);
  });

  it('keeps only the ports tagged with the visible face — rear elevation', () => {
    const o = occupant({
      id: 'nuc-01',
      ports: [port({ id: 'eth0', face: 'front' }), port({ id: 'psu', face: 'rear' })],
    });
    const item = shelfOccupantFaceplateItem(o, 'rear');
    expect(item.visibleFace).toBe('rear');
    expect(item.ports.map((p) => p.id)).toEqual(['psu']);
  });

  it('an occupant with nothing on the visible face draws with an empty ports list, never a guess', () => {
    const o = occupant({ id: 'ont-01', ports: [port({ id: 'lc', face: 'front' })] });
    expect(shelfOccupantFaceplateItem(o, 'rear').ports).toEqual([]);
  });
});

describe('shelfOccupantFaceplateItems: every occupant on the shelf, resolved for one elevation', () => {
  it('resolves every occupant, in the shelf\'s own (slot) order', () => {
    const s = shelf({
      id: 'shelf-a01',
      occupants: [
        occupant({ id: 'nuc-01', slot: 1, ports: [port({ id: 'eth0', face: 'front' })] }),
        occupant({ id: 'sw-desk-01', slot: 2, ports: [port({ id: 'p1', face: 'front' })] }),
      ],
    });
    const items = shelfOccupantFaceplateItems(s, 'front');
    expect(items.map((i) => i.occupant.id)).toEqual(['nuc-01', 'sw-desk-01']);
    expect(items.every((i) => i.visibleFace === 'front')).toBe(true);
  });
});
