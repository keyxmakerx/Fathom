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
