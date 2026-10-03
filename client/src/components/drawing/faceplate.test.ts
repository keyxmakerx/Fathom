import { describe, expect, it } from 'vitest';

import type { PortView } from './contract';
import { describePorts, layoutFaceplate, plateItems, portWhere } from './faceplate';

function port(id: string, over: Partial<PortView> = {}): PortView {
  return {
    id,
    label: id,
    connector: 'rj45',
    row: 0,
    column: 0,
    uplink: false,
    role: 'access',
    face: 'front',
    passThroughId: null,
    cable: null,
    ...over,
  };
}

/** A 24-port switch: odd ports on top, even below, two SFP+ uplinks. */
function switch24(): PortView[] {
  const ports: PortView[] = [];
  for (let i = 0; i < 24; i += 1) {
    ports.push(port(String(i + 1), { row: i % 2, rowKind: i % 2 === 0 ? 'top' : 'bottom', column: Math.floor(i / 2) }));
  }
  ports.push(port('25', { connector: 'sfp_plus', uplink: true, role: 'uplink', rowKind: 'single', column: 12, gapBefore: true }));
  ports.push(port('26', { connector: 'sfp_plus', uplink: true, role: 'uplink', rowKind: 'single', column: 13 }));
  return ports;
}

describe('layoutFaceplate', () => {
  it('draws both rows inside a 1U plate, uplinks to the right of the access ports', () => {
    const layout = layoutFaceplate(switch24(), 1, 'sw-01');
    for (const b of layout.boxes) {
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y + b.h).toBeLessThanOrEqual(16);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(244);
    }
    const top = layout.byId.get('1')!;
    const bottom = layout.byId.get('2')!;
    expect(bottom.y).toBeGreaterThan(top.y + top.h - 0.01);
    expect(layout.byId.get('25')!.x).toBeGreaterThan(layout.byId.get('24')!.x);
  });

  it('never overlaps two ports', () => {
    const boxes = layoutFaceplate(switch24(), 1, 'sw-01').boxes;
    for (const a of boxes) {
      for (const b of boxes) {
        if (a === b) continue;
        const apart = a.x + a.w <= b.x + 0.01 || b.x + b.w <= a.x + 0.01 || a.y + a.h <= b.y + 0.01 || b.y + b.h <= a.y + 0.01;
        expect(apart, `${a.id} vs ${b.id}`).toBe(true);
      }
    }
  });

  it('puts the name in the blank part of the plate when it fits', () => {
    expect(layoutFaceplate(switch24(), 1, 'sw-01').name.mode).toBe('inline');
  });

  it('moves a name that cannot fit to a tab', () => {
    expect(layoutFaceplate(switch24(), 1, 'a-very-long-switch-name-indeed').name.mode).toBe('tab');
  });

  it('flows hand-typed ports into two rows when there are many', () => {
    const typed = Array.from({ length: 16 }, (_, i) => port(String(i + 1)));
    const layout = layoutFaceplate(typed, 1, 'x');
    expect(new Set(layout.boxes.map((b) => b.y)).size).toBe(2);
  });

  it('draws nothing for an unrecognised connector', () => {
    expect(layoutFaceplate([port('1', { connector: 'weird' })], 1, 'x').boxes).toEqual([]);
  });
});

describe('words', () => {
  it('names where a port sits', () => {
    const layout = layoutFaceplate(switch24(), 1, 'sw-01');
    expect(portWhere(layout, '7')).toBe('top row, 4th from left');
  });

  it('lists the unit in words', () => {
    const ports = switch24();
    const lines = describePorts(ports, layoutFaceplate(ports, 1, 'sw-01'));
    expect(lines[0]).toBe('24 × RJ45, ports 1–24, two rows');
    expect(lines[1]).toBe('2 × SFP+, ports 25–26, uplinks, on the right');
  });
});

describe('plateItems', () => {
  it('is the ports themselves on the front, and stable', () => {
    const ports = switch24();
    expect(plateItems(ports, [], 'front')).toBe(ports);
  });
});
