import { describe, expect, it } from 'vitest';

import { highestFreeU, nextHostname, racksInPickOrder } from './pick';

type Rack = Parameters<typeof highestFreeU>[0] & { id: string; chassis: Array<{ id: string; positionU: number; heightU: number }> };

function rack(id: string, heightU: number, chassis: Array<[number, number]>, shelves: Array<[number, number]> = []): Rack {
  return {
    id,
    heightU,
    chassis: chassis.map(([positionU, h], i) => ({ id: `${id}-c${i}`, positionU, heightU: h })),
    shelves: shelves.map(([positionU, h]) => ({ positionU, heightU: h })),
  } as unknown as Rack;
}

describe('highestFreeU', () => {
  it('fills from the top of an empty rack', () => {
    expect(highestFreeU(rack('a', 42, []), 1)).toBe(42);
    expect(highestFreeU(rack('a', 42, []), 2)).toBe(41);
  });

  it('skips devices and shelves, and finds a gap tall enough', () => {
    const r = rack('a', 10, [[10, 1], [8, 1]], [[5, 2]]);
    expect(highestFreeU(r, 1)).toBe(9);
    expect(highestFreeU(r, 2)).toBe(3);
  });

  it('returns null when nothing that tall fits', () => {
    expect(highestFreeU(rack('a', 2, [[1, 1]]), 2)).toBeNull();
    expect(highestFreeU(rack('a', 1, []), 2)).toBeNull();
  });
});

describe('racksInPickOrder', () => {
  const racks = [rack('a', 42, []), rack('b', 42, [[1, 1]])];

  it('tries the selected rack first', () => {
    expect(racksInPickOrder(racks, { kind: 'rack', id: 'b' }).map((r) => r.id)).toEqual(['b', 'a']);
  });

  it("tries the selected device's rack first", () => {
    expect(racksInPickOrder(racks, { kind: 'chassis', id: 'b-c0' }).map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('keeps the order when nothing relevant is selected', () => {
    expect(racksInPickOrder(racks, null).map((r) => r.id)).toEqual(['a', 'b']);
    expect(racksInPickOrder(racks, { kind: 'port', id: 'x' }).map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('nextHostname', () => {
  it('numbers from 1 and skips names in use', () => {
    expect(nextHostname(new Set(), 'router')).toBe('router-1');
    expect(nextHostname(new Set(['switch-1', 'switch-2']), 'switch')).toBe('switch-3');
  });

  it('writes a role with an underscore as a hyphenated name', () => {
    expect(nextHostname(new Set(), 'access_point')).toBe('access-point-1');
  });
});
