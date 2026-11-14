import { describe, expect, it } from 'vitest';

import type { CableView, ClosetView } from './contract';
import { BOX_H, BOX_W, COLUMN_PITCH, diagramLines, layoutDiagram, orthRoute } from './diagram';

const chassis = (id: string, positionU: number) => ({ id, hostname: id, positionU }) as never;
const cable = (id: string, a: string, b: string): CableView =>
  ({ id, kind: 'copper', media: '', sheath: null, label: null, ends: [{ portId: `${id}-a`, chassisId: a, rackId: 'r' }, { portId: `${id}-b`, chassisId: b, rackId: 'r' }] }) as CableView;

describe('layoutDiagram', () => {
  it('puts each rack in a column, top unit first', () => {
    const view = { racks: [{ label: 'R1', chassis: [chassis('lo', 2), chassis('hi', 9)] }, { label: 'R2', chassis: [chassis('x', 1)] }], cables: [] } as unknown as ClosetView;
    const boxes = layoutDiagram(view);
    expect(boxes.map((b) => b.id)).toEqual(['hi', 'lo', 'x']);
    expect(boxes[0]!.y).toBeLessThan(boxes[1]!.y);
    expect(boxes[2]!.x).toBe(COLUMN_PITCH);
  });
});

describe('layoutDiagram: every device', () => {
  const rack = { label: 'R1', chassis: [chassis('racked', 4)], shelves: [{ id: 's', label: 'Shelf', positionU: 1, heightU: 1, occupants: [{ id: 'onshelf', kind: 'chassis', label: 'mini', chassis: { hostname: 'mini', role: 'server' } }, { id: 'panel', kind: 'passive', label: 'Panel' }] }] };
  const view = {
    racks: [rack],
    surfaces: [
      { id: 'desk', label: 'Desk', fixtures: [{ id: 'sw', kind: 'chassis', label: 'sw', chassis: { hostname: 'switch-2', role: 'switch' }, fixtures: [] }] },
      { id: 'wall', label: 'Wall', fixtures: [{ id: 'board', kind: 'passive', label: 'board', fixtures: [{ id: 'cam', kind: 'chassis', label: 'cam', chassis: { hostname: 'camera-1', role: null }, fixtures: [] }] }] },
    ],
    free: [{ id: 'free1', hostname: 'free-box', role: null }],
    unplaced: [{ id: 'free1', hostname: 'free-box', role: null }, { id: 'loose', hostname: 'loose', role: null }],
    cables: [],
  } as unknown as ClosetView;

  it('draws racked, shelved, wall, desk, free and unplaced devices once each, and no passives', () => {
    const ids = layoutDiagram(view).map((b) => b.id);
    expect(ids).toEqual(['racked', 'onshelf', 'sw', 'cam', 'free1', 'loose']);
  });
  it('gives each wall, desk and rack its own column', () => {
    const xs = layoutDiagram(view).map((b) => b.x / COLUMN_PITCH);
    expect(xs).toEqual([0, 0, 1, 2, 3, 3]);
  });
  it('lays surfaces and their devices out the same way whatever order the view lists them in', () => {
    const fx = (id: string, xMm: number | null, yMm: number | null) => ({ id, kind: 'chassis', label: id, xMm, yMm, chassis: { hostname: id, role: null }, fixtures: [] });
    const desk = { id: 'd', label: 'Desk', form: 'desk', fixtures: [fx('printer', 1300, 100), fx('unmeasured', null, null), fx('switch', 200, 100), fx('desktop', 700, 100), fx('shelf-pc', 100, 900)] };
    const wall = { id: 'w', label: 'Wall', form: 'wall', fixtures: [fx('cam2', 1700, 2200), fx('cam1', 300, 2200)] };
    const ceiling = { id: 'c', label: 'Ceiling', form: 'ceiling', fixtures: [fx('ap', 600, 600)] };
    const order = (surfaces: unknown[]) => layoutDiagram({ racks: [], surfaces, cables: [] } as unknown as ClosetView).map((b) => b.id);
    const want = ['cam1', 'cam2', 'switch', 'desktop', 'printer', 'shelf-pc', 'unmeasured', 'ap'];
    expect(order([desk, wall, ceiling])).toEqual(want);
    expect(order([ceiling, { ...desk, fixtures: [...desk.fixtures].reverse() }, wall])).toEqual(want);
  });
  it('carries the role so the icons look can pick an icon for a device that is not racked', () => {
    expect(layoutDiagram(view).find((b) => b.id === 'onshelf')?.role).toBe('server');
  });
});

describe('orthRoute', () => {
  const a = { x: 0, y: 0, w: BOX_W, h: BOX_H };
  it('runs straight down between boxes that overlap in x', () => {
    const r = orthRoute(a, { ...a, y: 200 });
    expect(r.d).toBe(`M ${BOX_W / 2} ${BOX_H} L ${BOX_W / 2} 200`);
    expect(r.a).toMatchObject({ dx: 0, dy: 1 });
    expect(r.b).toMatchObject({ dx: 0, dy: -1 });
  });
  it('runs straight across between boxes that overlap in y', () => {
    const r = orthRoute(a, { ...a, x: 400 });
    expect(r.d).toBe(`M ${BOX_W} ${BOX_H / 2} L 400 ${BOX_H / 2}`);
  });
  it('turns only at right angles otherwise', () => {
    const r = orthRoute(a, { ...a, x: 400, y: 300 });
    expect(r.d.startsWith('M')).toBe(true);
    const nums = r.d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    for (let i = 2; i < nums.length - 1; i += 2) expect(nums[i] === nums[i - 2] || nums[i + 1] === nums[i - 1]).toBe(true);
  });
  it('keeps parallel lanes apart', () => {
    const l = orthRoute(a, { ...a, y: 200 }, -8).a.x;
    const r = orthRoute(a, { ...a, y: 200 }, 8).a.x;
    expect(r - l).toBe(16);
  });
});

describe('diagramLines', () => {
  it('lanes cables between one pair and skips loops and undrawn boxes', () => {
    const view = { racks: [], cables: [cable('c1', 'A', 'B'), cable('c2', 'B', 'A'), cable('c3', 'A', 'A'), cable('c4', 'A', 'Z')] } as unknown as ClosetView;
    const lines = diagramLines(view, new Set(['A', 'B']));
    expect(lines.map((l) => l.cable.id)).toEqual(['c1', 'c2']);
    expect(lines.map((l) => l.lane)).toEqual([-4, 4]);
  });
});
