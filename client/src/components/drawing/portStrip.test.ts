// The switch port strip on the Diagram (sign-off r109, item 4).
import { describe, expect, it } from 'vitest';

import type { PortView } from '../../document/view';
import { BOX_W } from './diagram';
import { hasStrip, portStrip, STRIP_ONE_ROW, stripPorts } from './portStrip';

function port(i: number, over: Partial<PortView> = {}): PortView {
  return { id: `p${i}`, label: String(i), connector: 'rj45', row: 0, column: i, uplink: false, role: null, face: 'front', passThroughId: null, cable: null, ...over } as PortView;
}

describe('the switch port strip', () => {
  it('is drawn for a switch only', () => {
    expect(hasStrip('switch')).toBe(true);
    expect(hasStrip('server')).toBe(false);
    expect(hasStrip(null)).toBe(false);
  });

  it('holds the data ports in faceplate order, not power or console', () => {
    const ports = [port(2), port(1), port(3, { service: 'console' }), port(4, { connector: 'c14' }), port(5, { service: 'power' })];
    expect(stripPorts(ports).map((p) => p.label)).toEqual(['1', '2']);
  });

  it('puts a small switch in one row inside the box, left to right, a cabled port marked', () => {
    const ports = Array.from({ length: 8 }, (_, i) => port(i + 1, i === 2 ? { cable: {} as PortView['cable'] } : {}));
    const cells = portStrip(ports);
    expect(new Set(cells.map((c) => c.y)).size).toBe(1);
    for (let i = 1; i < cells.length; i += 1) expect(cells[i]!.x).toBeGreaterThan(cells[i - 1]!.x + cells[i - 1]!.w - 0.01);
    expect(cells[0]!.x).toBeGreaterThan(0);
    expect(cells.at(-1)!.x + cells.at(-1)!.w).toBeLessThan(BOX_W);
    expect(cells.map((c) => c.cabled)).toEqual([false, false, true, false, false, false, false, false]);
  });

  it('puts a big switch in two staggered rows, odd ports on top, each port its own exit', () => {
    const cells = portStrip(Array.from({ length: 48 }, (_, i) => port(i + 1)));
    expect(cells.length).toBeGreaterThan(STRIP_ONE_ROW);
    expect(cells[0]!.y).toBeLessThan(cells[1]!.y);
    expect(cells[0]!.y).toBe(cells[2]!.y);
    expect(new Set(cells.map((c) => c.exitX)).size).toBe(48);
    expect(Math.max(...cells.map((c) => c.x + c.w))).toBeLessThan(BOX_W);
  });

  it('draws nothing for a box with no data ports', () => {
    expect(portStrip([port(1, { service: 'power' })])).toEqual([]);
  });
});
