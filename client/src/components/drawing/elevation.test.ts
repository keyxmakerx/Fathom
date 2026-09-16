import { describe, expect, it } from 'vitest';

import type { ChassisView, InletView, PortView } from './contract';
import { faceplateItem, faceplateItems, visibleFaceOf } from './elevation';

function port(overrides: Partial<PortView> & Pick<PortView, 'id' | 'face'>): PortView {
  return { label: overrides.id, connector: 'rj45', row: 0, column: 0, uplink: false, role: null, cable: null, ...overrides };
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
