import { describe, expect, it } from 'vitest';

import type { TraceHop } from '../../engine/engine';
import { MARK_OUT, MARK_SIZE, markBox, markGrow, markText, markWidth, placeMarks, type MarkPlaces, type Spot } from './marks';

const hop = (n: number, kind: TraceHop['kind'], nodes: string[]): TraceHop => ({ n, kind, title: `h${n}`, detail: [], nodes, why: '', source: '', scope: '', policies: [], unplaced: [], unplacedWhy: '' });
// A port counts toward its device.
const canon = (id: string) => (id.startsWith('port:') ? `device:${id.split(':')[1]}` : id);

// A camera on a wall, a switch and a router two units apart in a rack, a NAS on the rack's shelf.
const RACK = { x: 0, y: 0, width: 300, height: 200 };
const places: MarkPlaces = {
  devices: new Map([
    ['device:cam', { x: 500, y: 60, width: 92, height: 63 }],
    ['device:sw', { x: 28, y: 80, width: 244, height: 16 }],
    ['device:rt', { x: 28, y: 48, width: 244, height: 16 }],
    ['device:nas', { x: 60, y: 113, width: 35, height: 13 }],
  ]),
  rows: new Set(['device:sw', 'device:rt']),
  cables: new Map([
    ['cable:cam-sw', { x: 380, y: 150 }],
    ['cable:sw-rt', { x: 150, y: 70 }],
  ]),
  racks: [RACK],
};
/** Where a one-hop mark stands for a rack row whose box starts at 28: clear of the row's left end, level with it. */
const RAIL = 28 - 2 - MARK_SIZE / 2;
const spot = (spots: readonly Spot[], ...ns: number[]) => spots.find((s) => s.ns.join() === ns.join());
const overlap = (a: Spot, b: Spot, grow = 1) => {
  const [p, q] = [markBox(a, grow), markBox(b, grow)];
  return p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;
};

describe('a mark', () => {
  it('says its hops, and only the lit ones while a trace plays', () => {
    expect(markText([4, 8])).toBe('4·8');
    expect(markText([4, 8], new Set([1, 2, 3, 4]))).toBe('4');
    expect(markText([4, 8], new Set([1]))).toBe('');
  });

  it('is as wide as its hops need and never narrower than it is tall', () => {
    expect(markWidth([3])).toBe(MARK_SIZE);
    expect(markWidth([10])).toBeGreaterThan(MARK_SIZE);
    expect(markWidth([6, 10])).toBeGreaterThan(markWidth([4, 8]));
  });

  it('keeps its size on the screen when the drawing is zoomed out, and grows with it zoomed in', () => {
    expect(markGrow(0.5)).toBe(2);
    expect(markGrow(1)).toBe(1);
    expect(markGrow(1.25)).toBe(1);
    expect(markBox({ ns: [3], x: 100, y: 50 }, 2)).toEqual({ x: 78, y: 28, width: 44, height: 44 });
  });
});

describe('placeMarks', () => {
  it("puts a device's mark just off its top left corner, and joins hops at one device", () => {
    const spots = placeMarks([hop(1, 'start', ['device:cam']), hop(2, 'device', ['port:cam:eth0'])], canon, places);
    expect(spot(spots, 1, 2)).toEqual({ ns: [1, 2], x: 500 - MARK_OUT, y: 60 - MARK_OUT });
  });

  it('stands the mark of anything thinner than itself at its left end, level with it', () => {
    // The NAS on the shelf is drawn 13 tall.
    const ten = placeMarks([hop(10, 'device', ['device:nas'])], canon, places)[0]!;
    expect(ten.y).toBe(113 + 13 / 2);
    expect(ten.x + markWidth([10]) / 2).toBeLessThan(60);
    // Drawn taller than a mark it has the mark on its corner, as a device on a wall does.
    const tall: MarkPlaces = { ...places, devices: new Map([['device:nas', { x: 60, y: 113, width: 70, height: 26 }]]) };
    expect(placeMarks([hop(10, 'device', ['device:nas'])], canon, tall)).toEqual([{ ns: [10], x: 60 - MARK_OUT, y: 113 - MARK_OUT }]);
  });

  it("stands a rack row's mark at the row's left end, level with the row, at any zoom", () => {
    expect(placeMarks([hop(4, 'device', ['device:sw'])], canon, places)).toEqual([{ ns: [4], x: RAIL, y: 80 + 8 }]);
    // Shown at twice its drawn size the mark is 44 across and the row still 16 tall: level with the row, not above it.
    expect(placeMarks([hop(4, 'device', ['device:sw'])], canon, places, 2)).toEqual([{ ns: [4], x: 28 - 4 - MARK_SIZE, y: 80 + 8 }]);
    // A device taller than a mark has it level with its top unit.
    const tall: MarkPlaces = { ...places, devices: new Map([['device:sw', { x: 28, y: 80, width: 244, height: 64 }]]) };
    expect(placeMarks([hop(4, 'device', ['device:sw'])], canon, tall)[0]!.y).toBe(80 + MARK_SIZE / 2);
  });

  it("carries a cable's mark on the middle of its line", () => {
    const spots = placeMarks([hop(3, 'cable', ['device:cam', 'cable:cam-sw', 'device:sw'])], canon, places);
    expect(spot(spots, 3)).toEqual({ ns: [3], x: 380, y: 150 });
  });

  it("numbers a cable inside one rack between its devices' marks, stepped out beside them", () => {
    const hops = [hop(4, 'device', ['device:sw']), hop(5, 'cable', ['device:sw', 'cable:sw-rt', 'device:rt']), hop(6, 'device', ['device:rt'])];
    const spots = placeMarks(hops, canon, places);
    const [four, five, six] = [spot(spots, 4)!, spot(spots, 5)!, spot(spots, 6)!];
    expect(five.y).toBe((80 + 48) / 2 + 8);
    expect(five.x).toBeLessThan(four.x - MARK_SIZE);
    expect(overlap(five, four)).toBe(false);
    expect(overlap(five, six)).toBe(false);
    // The two devices are two units apart: their marks share the column by the rack.
    expect(six.x).toBe(four.x);
  });

  it('keeps two rows two units apart in one column however far out the drawing is', () => {
    const hops = [hop(4, 'device', ['device:sw']), hop(6, 'device', ['device:rt'])];
    for (const grow of [1, 1.5, 2]) {
      const spots = placeMarks(hops, canon, places, grow);
      expect(spot(spots, 6)!.x).toBe(spot(spots, 4)!.x);
    }
    // One unit apart they cannot: the second steps out.
    const close: MarkPlaces = { ...places, devices: new Map([...places.devices, ['device:rt', { x: 28, y: 64, width: 244, height: 16 }]]) };
    const spots = placeMarks(hops, canon, close);
    expect(spot(spots, 6)!.x).toBeLessThan(spot(spots, 4)!.x - MARK_SIZE);
  });

  it('gives a mark the room of every hop it will carry, so it does not move as the trace plays', () => {
    const hops = [
      hop(4, 'device', ['device:sw']),
      hop(5, 'cable', ['device:sw', 'cable:sw-rt', 'device:rt']),
      hop(6, 'device', ['device:rt']),
      hop(7, 'cable', ['device:rt', 'cable:sw-rt', 'device:sw']),
      hop(8, 'device', ['device:sw']),
    ];
    const spots = placeMarks(hops, canon, places);
    expect(spots.map((s) => s.ns)).toEqual([[4, 8], [5, 7], [6]]);
    expect(overlap(spot(spots, 5, 7)!, spot(spots, 4, 8)!)).toBe(false);
    // Placed for its first hop alone it would need less room, so it is the whole trace that places it.
    expect(spot(spots, 5, 7)!.x).toBeLessThan(spot(placeMarks(hops.slice(0, 2), canon, places), 5)!.x);
  });

  it('marks a patch panel where its device is', () => {
    const spots = placeMarks([hop(4, 'device', ['device:sw']), hop(5, 'cable', ['port:sw:1', 'port:sw:2'])], canon, places);
    expect(spots.map((s) => s.ns)).toEqual([[4, 5]]);
    expect(spots[0]!.y).toBe(80 + 8);
  });

  it('falls back to between the devices for a cable with no line, and to nothing with no devices drawn', () => {
    const stubbed = placeMarks([hop(9, 'cable', ['device:sw', 'cable:sw-nas', 'device:nas'])], canon, places);
    expect(spot(stubbed, 9)).toEqual({ ns: [9], x: (RAIL + 60 - 2 - MARK_SIZE / 2) / 2, y: (80 + 8 + 113 + 13 / 2) / 2 });
    // Only one of its devices drawn: the mark is that device's.
    expect(placeMarks([hop(9, 'cable', ['device:sw', 'cable:sw-x', 'device:x'])], canon, places).map((s) => s.ns)).toEqual([[9]]);
    expect(placeMarks([hop(9, 'cable', ['device:x', 'cable:none', 'device:y'])], canon, places)).toEqual([]);
  });

  it('gives a mark more room when it is shown larger than drawn', () => {
    const hops = [hop(4, 'device', ['device:sw']), hop(5, 'cable', ['device:sw', 'cable:sw-rt', 'device:rt'])];
    const [near, far] = [placeMarks(hops, canon, places, 1), placeMarks(hops, canon, places, 1.5)];
    expect(spot(far, 4)!.x - spot(far, 5)!.x).toBeGreaterThan(spot(near, 4)!.x - spot(near, 5)!.x);
    expect(overlap(spot(far, 5)!, spot(far, 4)!, 1.5)).toBe(false);
  });

  it('skips a stop, which names nothing on the canvas', () => {
    expect(placeMarks([hop(7, 'stop', ['device:sw'])], canon, places)).toEqual([]);
  });
});
