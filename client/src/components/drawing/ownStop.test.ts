import { describe, expect, it } from 'vitest';

import { fixtureKindSaid, leftToRight } from './ownStop';
import { enterSelectsHere } from './nodeKey';
import { fixtureSays } from './thingSays';

const at = (id: string, xMm: number | null, yMm: number | null) => ({ id, xMm, yMm });

describe('a thing on a wall takes a Tab stop (r159)', () => {
  it('Tab goes left to right, and at one place from the top down', () => {
    const order = leftToRight([at('printer', 900, 700), at('switch', 100, 700), at('desktop', 500, 700), at('shelf-high', 100, 1500)]);
    expect(order.map((f) => f.id)).toEqual(['shelf-high', 'switch', 'desktop', 'printer']);
  });

  it('a thing not measured across goes last, in the order the wall holds them', () => {
    const order = leftToRight([at('b', null, 100), at('a', 300, 100), at('c', null, 900)]);
    expect(order.map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });

  it('is named as React Flow names a device: its name, then what it is', () => {
    expect(fixtureSays({ label: 'switch-2', form: null, chassis: { role: 'switch' } })).toBe('switch-2, switch');
    expect(fixtureSays({ label: 'ap-1', form: null, chassis: { role: 'access_point' } })).toBe('ap-1, access point');
    expect(fixtureSays({ label: 'strip', form: 'outlet', chassis: undefined })).toBe('strip, outlet');
    expect(fixtureKindSaid({ kind: 'chassis', form: null })).toBe('device');
    expect(fixtureKindSaid({ kind: 'passive', form: 'patch_panel' })).toBe('patch panel');
    expect(fixtureKindSaid({ kind: 'passive', form: null })).toBe('thing');
  });

  it('Enter selects it only when pressed on the thing itself, not on one of its ports', () => {
    const thing = {} as EventTarget;
    const port = {} as EventTarget;
    const enter = { key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, defaultPrevented: false };
    expect(enterSelectsHere({ ...enter, target: thing, currentTarget: thing })).toBe(true);
    expect(enterSelectsHere({ ...enter, target: port, currentTarget: thing })).toBe(false);
    expect(enterSelectsHere({ ...enter, repeat: true, target: thing, currentTarget: thing })).toBe(false);
    expect(enterSelectsHere({ ...enter, ctrlKey: true, target: thing, currentTarget: thing })).toBe(false);
    expect(enterSelectsHere({ ...enter, key: ' ', target: thing, currentTarget: thing })).toBe(false);
  });
});
