import { describe, expect, it } from 'vitest';

import type { ChassisView, ClosetView, PortView } from './contract';
import { groupPortals } from './portals';
import { isPanel, litPathFor, pairedPort } from './paths';

function port(overrides: Partial<PortView> & Pick<PortView, 'id' | 'label'>): PortView {
  return { connector: 'rj45', row: 0, column: 0, uplink: false, cable: null, ...overrides };
}

function chassis(overrides: Partial<ChassisView> & Pick<ChassisView, 'id'>): ChassisView {
  return {
    deviceId: `${overrides.id}-device`,
    hostname: overrides.id,
    model: 'MODEL',
    vendor: 'vendor',
    positionU: 1,
    heightU: 1,
    face: 'front',
    role: null,
    managementAddress: null,
    serial: null,
    psuInlets: [{ id: `${overrides.id}-psu`, label: '1', connector: 'c14', row: 0, column: 0, uplink: false, cable: null }],
    singleFed: false,
    ports: [],
    ...overrides,
  };
}

function panel(overrides: Partial<ChassisView> & Pick<ChassisView, 'id'>): ChassisView {
  // UI-SPEC "no catalogue psu_inlets" reads as unpowered — `paths.ts`'s
  // `isPanel`. A real panel fixture has none.
  return chassis({ psuInlets: [], ...overrides });
}

describe('isPanel', () => {
  it('a chassis with psu inlets is not a panel', () => {
    expect(isPanel(chassis({ id: 'c' }))).toBe(false);
  });

  it('a chassis with an empty psuInlets is a panel', () => {
    expect(isPanel(panel({ id: 'p' }))).toBe(true);
  });
});

describe('pairedPort', () => {
  it('pairs the same label on a different row', () => {
    const p = panel({
      id: 'panel-1',
      ports: [port({ id: 'front-7', label: '7', row: 0 }), port({ id: 'rear-7', label: '7', row: 1 })],
    });
    expect(pairedPort(p, p.ports[0])?.id).toBe('rear-7');
    expect(pairedPort(p, p.ports[1])?.id).toBe('front-7');
  });

  it('two ports with the same label and the same row are not a pair', () => {
    const p = panel({
      id: 'panel-1',
      ports: [port({ id: 'a', label: '7', row: 0 }), port({ id: 'b', label: '7', row: 0 })],
    });
    expect(pairedPort(p, p.ports[0])).toBeUndefined();
  });

  it('a different label on the other row is not a pair', () => {
    const p = panel({
      id: 'panel-1',
      ports: [port({ id: 'a', label: '7', row: 0 }), port({ id: 'b', label: '8', row: 1 })],
    });
    expect(pairedPort(p, p.ports[0])).toBeUndefined();
  });
});

/** Two hops: acc-01 -> patch-01 (front p7) | (rear p7) -> dist-01. */
function twoHopView(): ClosetView {
  const accToPanel = 'cable-1';
  const panelToDist = 'cable-2';
  const acc = chassis({
    id: 'acc-01',
    ports: [port({ id: 'acc-port', label: '1', cable: { cableId: accToPanel, farPortId: 'panel-front-7', farChassisId: 'patch-01', outsideCloset: false } })],
  });
  const dist = chassis({
    id: 'dist-01',
    ports: [port({ id: 'dist-port', label: '1', cable: { cableId: panelToDist, farPortId: 'panel-rear-7', farChassisId: 'patch-01', outsideCloset: false } })],
  });
  const patch = panel({
    id: 'patch-01',
    ports: [
      port({ id: 'panel-front-7', label: '7', row: 0, cable: { cableId: accToPanel, farPortId: 'acc-port', farChassisId: 'acc-01', outsideCloset: false } }),
      port({ id: 'panel-rear-7', label: '7', row: 1, cable: { cableId: panelToDist, farPortId: 'dist-port', farChassisId: 'dist-01', outsideCloset: false } }),
    ],
  });
  return {
    premisesId: 'closet-1',
    racks: [{ id: 'rack-1', label: 'A-04', heightU: 42, unitNumbering: 'bottom-up', freeRuns: [], chassis: [acc, patch, dist] }],
    cables: [
      { id: accToPanel, kind: 'copper', media: 'cat6', sheath: 'grey', label: null, ends: [{ portId: 'acc-port', chassisId: 'acc-01', rackId: 'rack-1' }, { portId: 'panel-front-7', chassisId: 'patch-01', rackId: 'rack-1' }] },
      { id: panelToDist, kind: 'copper', media: 'cat6', sheath: 'blue', label: null, ends: [{ portId: 'panel-rear-7', chassisId: 'patch-01', rackId: 'rack-1' }, { portId: 'dist-port', chassisId: 'dist-01', rackId: 'rack-1' }] },
    ],
  };
}

describe('litPathFor: two-hop, through one panel', () => {
  it('hovering the near cable lights both cables, in order', () => {
    const path = litPathFor(twoHopView(), 'cable-1', []);
    expect(path.cableIds).toEqual(['cable-1', 'cable-2']);
    expect(path.trayKeys).toEqual([]);
  });

  it('hovering the far cable lights the same path, still in order', () => {
    const path = litPathFor(twoHopView(), 'cable-2', []);
    expect(path.cableIds).toEqual(['cable-1', 'cable-2']);
  });

  it('an unknown starting cable id lights nothing', () => {
    expect(litPathFor(twoHopView(), 'nope', [])).toEqual({ cableIds: [], trayKeys: [] });
  });
});

/** Three hops: acc-01 -> patch-A (p7|p7) -> patch-B (p3|p3) -> core-01. */
function threeHopView(): ClosetView {
  const c1 = 'cable-1'; // acc-01 -> patch-A front
  const c2 = 'cable-2'; // patch-A rear -> patch-B front
  const c3 = 'cable-3'; // patch-B rear -> core-01
  const acc = chassis({ id: 'acc-01', ports: [port({ id: 'acc-port', label: '1', cable: { cableId: c1, farPortId: 'a-front-7', farChassisId: 'patch-a', outsideCloset: false } })] });
  const patchA = panel({
    id: 'patch-a',
    ports: [
      port({ id: 'a-front-7', label: '7', row: 0, cable: { cableId: c1, farPortId: 'acc-port', farChassisId: 'acc-01', outsideCloset: false } }),
      port({ id: 'a-rear-7', label: '7', row: 1, cable: { cableId: c2, farPortId: 'b-front-3', farChassisId: 'patch-b', outsideCloset: false } }),
    ],
  });
  const patchB = panel({
    id: 'patch-b',
    ports: [
      port({ id: 'b-front-3', label: '3', row: 0, cable: { cableId: c2, farPortId: 'a-rear-7', farChassisId: 'patch-a', outsideCloset: false } }),
      port({ id: 'b-rear-3', label: '3', row: 1, cable: { cableId: c3, farPortId: 'core-port', farChassisId: 'core-01', outsideCloset: false } }),
    ],
  });
  const core = chassis({ id: 'core-01', ports: [port({ id: 'core-port', label: '1', cable: { cableId: c3, farPortId: 'b-rear-3', farChassisId: 'patch-b', outsideCloset: false } })] });
  return {
    premisesId: 'closet-1',
    racks: [{ id: 'rack-1', label: 'A-04', heightU: 42, unitNumbering: 'bottom-up', freeRuns: [], chassis: [acc, patchA, patchB, core] }],
    cables: [
      { id: c1, kind: 'copper', media: 'cat6', sheath: 'grey', label: null, ends: [{ portId: 'acc-port', chassisId: 'acc-01', rackId: 'rack-1' }, { portId: 'a-front-7', chassisId: 'patch-a', rackId: 'rack-1' }] },
      { id: c2, kind: 'copper', media: 'cat6', sheath: 'blue', label: null, ends: [{ portId: 'a-rear-7', chassisId: 'patch-a', rackId: 'rack-1' }, { portId: 'b-front-3', chassisId: 'patch-b', rackId: 'rack-1' }] },
      { id: c3, kind: 'copper', media: 'cat6', sheath: 'red', label: null, ends: [{ portId: 'b-rear-3', chassisId: 'patch-b', rackId: 'rack-1' }, { portId: 'core-port', chassisId: 'core-01', rackId: 'rack-1' }] },
    ],
  };
}

describe('litPathFor: three-hop, through two panels', () => {
  it('hovering the middle segment lights all three, in order, from either end', () => {
    const path = litPathFor(threeHopView(), 'cable-2', []);
    expect(path.cableIds).toEqual(['cable-1', 'cable-2', 'cable-3']);
  });

  it('hovering either end also lights the full three-hop path', () => {
    expect(litPathFor(threeHopView(), 'cable-1', []).cableIds).toEqual(['cable-1', 'cable-2', 'cable-3']);
    expect(litPathFor(threeHopView(), 'cable-3', []).cableIds).toEqual(['cable-1', 'cable-2', 'cable-3']);
  });
});

/** A cable that ends at a portal after one panel hop: acc-01 -> patch-01
 * (p7|p7) -> outside "up the riser". */
function panelToPortalView(): { view: ClosetView; trayKey: string } {
  const c1 = 'cable-1';
  const c2 = 'cable-2';
  const acc = chassis({ id: 'acc-01', ports: [port({ id: 'acc-port', label: '1', cable: { cableId: c1, farPortId: 'front-7', farChassisId: 'patch-01', outsideCloset: false } })] });
  const patch = panel({
    id: 'patch-01',
    positionU: 40,
    ports: [
      port({ id: 'front-7', label: '7', row: 0, cable: { cableId: c1, farPortId: 'acc-port', farChassisId: 'acc-01', outsideCloset: false } }),
      port({ id: 'rear-7', label: '7', row: 1, cable: { cableId: c2, farPortId: null, farChassisId: null, outsideCloset: true } }),
    ],
  });
  const view: ClosetView = {
    premisesId: 'closet-1',
    racks: [{ id: 'rack-1', label: 'A-04', heightU: 42, unitNumbering: 'bottom-up', freeRuns: [], chassis: [acc, patch] }],
    cables: [
      { id: c1, kind: 'copper', media: 'cat6', sheath: 'grey', label: null, ends: [{ portId: 'acc-port', chassisId: 'acc-01', rackId: 'rack-1' }, { portId: 'front-7', chassisId: 'patch-01', rackId: 'rack-1' }] },
      { id: c2, kind: 'fibre', media: 'om4', sheath: 'aqua', label: null, ends: [{ portId: 'rear-7', chassisId: 'patch-01', rackId: 'rack-1' }, { outside: true, label: 'up the riser → MDF A-01' }] },
    ],
  };
  const groups = groupPortals(view);
  return { view, trayKey: groups[0].key };
}

describe('litPathFor: a panel hop that ends at a portal', () => {
  it('the path reaches the tray the continuation crosses at, named by its own group key', () => {
    const { view, trayKey } = panelToPortalView();
    const path = litPathFor(view, 'cable-1', groupPortals(view));
    expect(path.cableIds).toEqual(['cable-1', 'cable-2']);
    expect(path.trayKeys).toEqual([trayKey]);
  });

  it('starting from the cable that itself leaves the closet also names the tray', () => {
    const { view, trayKey } = panelToPortalView();
    const path = litPathFor(view, 'cable-2', groupPortals(view));
    expect(path.cableIds).toEqual(['cable-1', 'cable-2']);
    expect(path.trayKeys).toEqual([trayKey]);
  });
});
