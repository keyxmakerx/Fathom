import { describe, expect, it } from 'vitest';

import type { ChassisView, RackView } from './contract';
import { chassisToDraw } from './faces';

function chassis(overrides: Partial<ChassisView> & Pick<ChassisView, 'id' | 'positionU' | 'face'>): ChassisView {
  return {
    deviceId: `${overrides.id}-device`,
    hostname: overrides.id,
    model: 'MODEL',
    vendor: 'vendor',
    heightU: 1,
    role: null,
    managementAddress: null,
    serial: null,
    psuInlets: [],
    singleFed: false,
    ports: [],
    ...overrides,
  };
}

describe('chassisToDraw: closet and rack stops (the flip)', () => {
  const rack: Pick<RackView, 'chassis'> = {
    chassis: [
      chassis({ id: 'front-1', positionU: 10, face: 'front' }),
      chassis({ id: 'rear-1', positionU: 10, face: 'rear' }),
      chassis({ id: 'front-2', positionU: 20, face: 'front' }),
    ],
  };

  it('facing "front" draws only front chassis', () => {
    const items = chassisToDraw(rack, 'rack', 'front');
    expect(items.map((i) => i.chassis.id)).toEqual(['front-1', 'front-2']);
    expect(items.every((i) => i.rear === false)).toBe(true);
  });

  it('facing "rear" draws only rear chassis', () => {
    const items = chassisToDraw(rack, 'rack', 'rear');
    expect(items.map((i) => i.chassis.id)).toEqual(['rear-1']);
    expect(items[0].rear).toBe(true);
  });

  it('the closet stop obeys the same flip as the rack stop', () => {
    expect(chassisToDraw(rack, 'closet', 'rear').map((i) => i.chassis.id)).toEqual(['rear-1']);
  });
});

describe('chassisToDraw: faceplate stop (both faces, rear stacked)', () => {
  it('every front chassis draws, plus every rear chassis stacked under a same-U front neighbour', () => {
    const rack: Pick<RackView, 'chassis'> = {
      chassis: [
        chassis({ id: 'front-1', positionU: 10, face: 'front' }),
        chassis({ id: 'rear-1', positionU: 10, face: 'rear' }),
      ],
    };
    const items = chassisToDraw(rack, 'faceplate', 'front');
    expect(items).toHaveLength(2);
    const front = items.find((i) => i.chassis.id === 'front-1')!;
    const rear = items.find((i) => i.chassis.id === 'rear-1')!;
    expect(front.rear).toBe(false);
    expect(rear.rear).toBe(true);
    expect(rear.stackedUnderChassisId).toBe('front-1');
  });

  it('a rear chassis with no front neighbour at its U still draws — never a silent gap', () => {
    const rack: Pick<RackView, 'chassis'> = {
      chassis: [chassis({ id: 'rear-only', positionU: 5, face: 'rear' })],
    };
    const items = chassisToDraw(rack, 'faceplate', 'front');
    expect(items).toHaveLength(1);
    expect(items[0].chassis.id).toBe('rear-only');
    expect(items[0].rear).toBe(true);
    expect(items[0].stackedUnderChassisId).toBeUndefined();
  });

  it('the faceplate stop ignores the flip — both faces draw regardless of `facing`', () => {
    const rack: Pick<RackView, 'chassis'> = {
      chassis: [chassis({ id: 'front-1', positionU: 10, face: 'front' }), chassis({ id: 'rear-1', positionU: 10, face: 'rear' })],
    };
    expect(chassisToDraw(rack, 'faceplate', 'front').map((i) => i.chassis.id).sort()).toEqual(['front-1', 'rear-1']);
    expect(chassisToDraw(rack, 'faceplate', 'rear').map((i) => i.chassis.id).sort()).toEqual(['front-1', 'rear-1']);
  });
});
