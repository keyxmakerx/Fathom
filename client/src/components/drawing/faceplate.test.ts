import { describe, expect, it } from 'vitest';

import type { InletView, PortView } from './contract';
import { describePorts, layoutFaceplate, plateItems, portSays, portWhere } from './faceplate';

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

  it('draws a hand-typed port with no connector named as the plain glyph', () => {
    const typed = Array.from({ length: 13 }, (_, i) => port(`Et${i + 1}`, { connector: '' }));
    const boxes = layoutFaceplate(typed, 1, 'sweetch').boxes;
    expect(boxes).toHaveLength(13);
    expect(new Set(boxes.map((b) => b.kind))).toEqual(new Set(['generic']));
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

  const CABLE = { cableId: 'c1', farPortId: 'far', farChassisId: 'sw-02', outsideCloset: false };

  it('says what a port on a plate is: its name for a screen reader, and its tip', () => {
    const ports = switch24();
    const layout = layoutFaceplate(ports, 1, 'sw-01');
    expect(portSays(port('7'), portWhere(layout, '7'), null)).toBe('Port 7 · RJ45 · top row, 4th from left · free');
    expect(portSays(port('7', { cable: CABLE }), portWhere(layout, '7'), null)).toBe('Port 7 · RJ45 · top row, 4th from left · cabled');
  });

  it('leaves out where it sits for a port in a plain row, on a wall or a shelf', () => {
    expect(portSays(port('eth0', { cable: CABLE }), null, null)).toBe('Port eth0 · RJ45 · cabled');
    expect(portSays(port('4'), null, null)).toBe('Port 4 · RJ45 · free');
    // More than the bare label the picture inside the button once gave it.
    expect(portSays(port('4'), null, null)).not.toBe('4');
  });

  it('says Port alone for one with no label, and the connector as typed where it is not one it knows', () => {
    expect(portSays(port('p1', { label: '' }), null, null)).toBe('Port · RJ45 · free');
    expect(portSays(port('p2', { label: 'aux', connector: 'db9' }), null, null)).toBe('Port aux · DB9 · free');
  });

  it('says the optic in a cage, or that the cage is empty', () => {
    expect(portSays(port('25', { connector: 'sfp_plus', optic: { type: '10GBASE-SR' } }), null, null)).toBe('Port 25 · SFP+ · optic 10GBASE-SR · free');
    expect(portSays(port('25', { connector: 'sfp_plus', optic: { part: 'SFP-10G-SR' } }), null, null)).toBe('Port 25 · SFP+ · optic SFP-10G-SR · free');
    expect(portSays(port('25', { connector: 'sfp_plus', optic: {} }), null, null)).toBe('Port 25 · SFP+ · optic fitted · free');
    expect(portSays(port('26', { connector: 'sfp_plus', optic: null }), null, null)).toBe('Port 26 · SFP+ · empty cage · free');
  });

  it('names an inlet by its slot, and says when no supply is fitted', () => {
    const inlet = (over: Partial<InletView>): InletView => ({
      ...port('psu', { connector: 'c14', label: 'inlet' }),
      slot: 'PSU1',
      hotSwap: true,
      fitted: true,
      supplyId: null,
      serial: null,
      model: null,
      position: { row: 'single', column: 0 },
      ...over,
    });
    expect(portSays(inlet({}), null, inlet({}))).toBe('PSU1 · C14 · free');
    expect(portSays(inlet({ cable: CABLE }), null, inlet({ cable: CABLE }))).toBe('PSU1 · C14 · cabled');
    expect(portSays(inlet({ fitted: false }), null, inlet({ fitted: false }))).toBe('PSU1 · C14 · not fitted');
    expect(portSays(inlet({ slot: '' }), null, inlet({ slot: '' }))).toBe('inlet · C14 · free');
  });
});

describe('plateItems', () => {
  it('is the ports themselves on the front, and stable', () => {
    const ports = switch24();
    expect(plateItems(ports, [], 'front')).toBe(ports);
  });
});
