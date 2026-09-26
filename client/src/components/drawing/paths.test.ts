import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../../api/catalogue';
import { placeChassis, createRack } from '../../document/commands';
import { emptyDocument, formatNodeId, type Document } from '../../document/model';
import { newUlid } from '../../document/ulid';
import { viewOf } from '../../document/view';
import type { ChassisView, ClosetView, PortView } from './contract';
import { groupPortals } from './portals';
import { isPanel, litPathFor, pairedPort, pairedPortFor } from './paths';

const NOW = 1_700_000_000_000;

function port(overrides: Partial<PortView> & Pick<PortView, 'id' | 'label'>): PortView {
  return {
    connector: 'rj45',
    row: 0,
    column: 0,
    uplink: false,
    role: null,
    cable: null,
    face: 'front',
    passThroughId: null,
    ...overrides,
  };
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
    psuInlets: [
      {
        id: `${overrides.id}-psu`,
        label: '1',
        connector: 'c14',
        row: 0,
        column: 0,
        uplink: false,
        cable: null,
        face: 'front',
        passThroughId: null,
        slot: 'PSU 0',
        role: null,
        serial: null,
        model: null,
        hotSwap: true,
        fitted: true,
        supplyId: null,
        position: { row: 'single', column: 0 },
      },
    ],
    singleFed: false,
    oneFitted: false,
    ports: [],
    placement: { kind: 'rack', rackId: 'rack-1', positionU: 1, face: 'front' },
    sketch: false,
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

describe('pairedPortFor: ADR-0051 §1 — passThroughId first, the label/row guess only as a fallback', () => {
  it('reads the real PassThrough edge view-wide when passThroughId is set', () => {
    // `document/view.ts` sets the SAME edge id on both ports a `PassThrough`
    // joins (it is symmetric) — never one port's own id, so both ports here
    // carry the identical `passThroughId`, matching what `viewOf` emits.
    const p = panel({
      id: 'panel-1',
      ports: [
        port({ id: 'front-7', label: '7', row: 0, passThroughId: 'pass-through:1' }),
        port({ id: 'rear-9', label: '9', row: 1, passThroughId: 'pass-through:1' }),
      ],
    });
    const view: ClosetView = {
      premisesId: 'closet-1',
      unplaced: [],
      rows: [],
      surfaces: [],
      cables: [],
      racks: [{ id: 'rack-1', label: 'A-04', heightU: 42, unitNumbering: 'bottom-up', freeRuns: [], row: null, bay: null, shelves: [], chassis: [p] }],
    };
    expect(pairedPortFor(view, p, p.ports[0])?.id).toBe('rear-9');
  });

  it('falls back to the label/row guess only when passThroughId is null', () => {
    const p = panel({
      id: 'panel-1',
      ports: [port({ id: 'front-7', label: '7', row: 0 }), port({ id: 'rear-7', label: '7', row: 1 })],
    });
    const view: ClosetView = {
      premisesId: 'closet-1',
      unplaced: [],
      rows: [],
      surfaces: [],
      cables: [],
      racks: [{ id: 'rack-1', label: 'A-04', heightU: 42, unitNumbering: 'bottom-up', freeRuns: [], row: null, bay: null, shelves: [], chassis: [p] }],
    };
    expect(pairedPortFor(view, p, p.ports[0])?.id).toBe('rear-7');
  });

  it('a passThroughId this view cannot locate stops the walk rather than guessing past it', () => {
    const p = panel({
      id: 'panel-1',
      ports: [
        port({ id: 'front-7', label: '7', row: 0, passThroughId: 'pass-through:nowhere' }),
        port({ id: 'rear-7', label: '7', row: 1 }),
      ],
    });
    const view: ClosetView = {
      premisesId: 'closet-1',
      unplaced: [],
      rows: [],
      surfaces: [],
      cables: [],
      racks: [{ id: 'rack-1', label: 'A-04', heightU: 42, unitNumbering: 'bottom-up', freeRuns: [], row: null, bay: null, shelves: [], chassis: [p] }],
    };
    expect(pairedPortFor(view, p, p.ports[0])).toBeUndefined();
  });

  it('resolves against what viewOf actually emits for a real PassThrough edge, not a hand-built id', () => {
    // Drives the real document side (`document/commands.ts`'s `placeChassis`,
    // `document/view.ts`'s `viewOf`) rather than a hand-built `ClosetView`,
    // so this locks in the actual shape `passThroughId` carries — a
    // `PassThrough` EDGE id shared by both ports, not either port's own id.
    const premisesId = formatNodeId('Premises', newUlid(NOW));
    const withPremises: Document = { ...emptyDocument(), nodes: [{ id: premisesId, existence: newUlid(NOW), fields: {} }] };
    const withRack = createRack(withPremises, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', now: NOW });
    const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
    const panelModel: CatalogueModel = {
      vendor: 'vendor',
      model: 'patch-panel',
      rackUnits: 1,
      reviewedBy: 'reviewer',
      source: { cite: 'cite', readOn: '2026-09-14' },
      psuSlots: [],
      faceplates: [
        { face: 'front', portCount: 1, ports: [{ kind: 'RJ45', number: 7, uplink: false, row: 'single', column: 0, groupGapBefore: false }] },
        { face: 'rear', portCount: 1, ports: [{ kind: 'RJ45', number: 12, uplink: false, row: 'single', column: 0, groupGapBefore: false }] },
      ],
    };
    const withChassis = placeChassis(withRack, rackId, { ...panelModel, form: 'panel' } as CatalogueModel & { form: string }, 10, 'front', { now: NOW });

    const closet = viewOf(withChassis, [panelModel]);
    const rack = closet.racks.find((r) => r.id === rackId)!;
    const panel = rack.chassis[0];
    const front = panel.ports.find((p) => p.face === 'front')!;
    const rear = panel.ports.find((p) => p.face === 'rear')!;

    // The producer's actual contract: an edge id, identical on both ports.
    expect(front.passThroughId).not.toBeNull();
    expect(front.passThroughId).toBe(rear.passThroughId);

    expect(pairedPortFor(closet, panel, front)?.id).toBe(rear.id);
    expect(pairedPortFor(closet, panel, rear)?.id).toBe(front.id);
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
    unplaced: [],
    rows: [],
    surfaces: [],
    racks: [{ id: 'rack-1', label: 'A-04', heightU: 42, unitNumbering: 'bottom-up', freeRuns: [], row: null, bay: null, shelves: [], chassis: [acc, patch, dist] }],
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
    unplaced: [],
    rows: [],
    surfaces: [],
    racks: [{ id: 'rack-1', label: 'A-04', heightU: 42, unitNumbering: 'bottom-up', freeRuns: [], row: null, bay: null, shelves: [], chassis: [acc, patchA, patchB, core] }],
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
    unplaced: [],
    rows: [],
    surfaces: [],
    racks: [{ id: 'rack-1', label: 'A-04', heightU: 42, unitNumbering: 'bottom-up', freeRuns: [], row: null, bay: null, shelves: [], chassis: [acc, patch] }],
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

/** ADR-0051 §1: two hops through an OUTLET BOX, paired by `passThroughId`
 * rather than label/row — a wall outlet's own front (room-facing) jack
 * PassThrough's its rear (cable-side) termination, exactly the "outlet"
 * half of "a panel's or outlet's pairing is written as the schema's
 * `PassThrough` edge at placement." `PassThrough` is `symmetric: true`
 * (`schema/schema.yaml`), so `document/view.ts` sets the SAME edge id as
 * `passThroughId` on BOTH ports (never each other's port id) — the fixture
 * below does the same, so a walk started from either cable finds its way.
 * The outlet box itself has empty `psuInlets` (`isPanel` true, same as a
 * patch panel — it draws unpowered), but the walk no longer depends on
 * that: `front-jack.passThroughId` and `rear-term.passThroughId` both name
 * the same `PassThrough` edge, and `portByPassThroughId` finds the other
 * port that carries it. desk-01 -> outlet-01 (front|rear, passThroughId) ->
 * idf-sw-01. */
function outletBoxView(): ClosetView {
  const deskToOutlet = 'cable-1';
  const outletToSwitch = 'cable-2';
  const desk = chassis({
    id: 'desk-01',
    ports: [port({ id: 'desk-port', label: '1', cable: { cableId: deskToOutlet, farPortId: 'front-jack', farChassisId: 'outlet-01', outsideCloset: false } })],
  });
  const idfSwitch = chassis({
    id: 'idf-sw-01',
    ports: [port({ id: 'sw-port', label: '1', cable: { cableId: outletToSwitch, farPortId: 'rear-term', farChassisId: 'outlet-01', outsideCloset: false } })],
  });
  const outlet = panel({
    id: 'outlet-01',
    ports: [
      port({
        id: 'front-jack',
        label: 'A',
        row: 0,
        passThroughId: 'pass-through:outlet-01',
        cable: { cableId: deskToOutlet, farPortId: 'desk-port', farChassisId: 'desk-01', outsideCloset: false },
      }),
      port({
        id: 'rear-term',
        label: 'A-run',
        row: 1,
        passThroughId: 'pass-through:outlet-01',
        cable: { cableId: outletToSwitch, farPortId: 'sw-port', farChassisId: 'idf-sw-01', outsideCloset: false },
      }),
    ],
  });
  return {
    premisesId: 'closet-1',
    unplaced: [],
    rows: [],
    surfaces: [],
    racks: [{ id: 'rack-1', label: 'A-04', heightU: 42, unitNumbering: 'bottom-up', freeRuns: [], row: null, bay: null, shelves: [], chassis: [desk, outlet, idfSwitch] }],
    cables: [
      { id: deskToOutlet, kind: 'copper', media: 'cat6', sheath: 'grey', label: null, ends: [{ portId: 'desk-port', chassisId: 'desk-01', rackId: 'rack-1' }, { portId: 'front-jack', chassisId: 'outlet-01', rackId: 'rack-1' }] },
      { id: outletToSwitch, kind: 'copper', media: 'cat6', sheath: 'blue', label: null, ends: [{ portId: 'rear-term', chassisId: 'outlet-01', rackId: 'rack-1' }, { portId: 'sw-port', chassisId: 'idf-sw-01', rackId: 'rack-1' }] },
    ],
  };
}

describe('litPathFor: two hops through an outlet box (passThroughId)', () => {
  it('hovering the near cable lights both cables, in order', () => {
    const path = litPathFor(outletBoxView(), 'cable-1', []);
    expect(path.cableIds).toEqual(['cable-1', 'cable-2']);
  });

  it('hovering the far cable lights the same path', () => {
    const path = litPathFor(outletBoxView(), 'cable-2', []);
    expect(path.cableIds).toEqual(['cable-1', 'cable-2']);
  });
});

/** ADR-0051 §1: two hops through a PANEL, paired by `passThroughId` — the
 * same `twoHopView` shape as the label/row test above, but the panel's two
 * ports now carry the real edge instead of matching by label, and their
 * labels deliberately differ (`7` / `12`) so a pass would fail if the walk
 * silently fell back to the old label guess. */
function panelViaPassThroughView(): ClosetView {
  const accToPanel = 'cable-1';
  const panelToDist = 'cable-2';
  const acc = chassis({
    id: 'acc-01',
    ports: [port({ id: 'acc-port', label: '1', cable: { cableId: accToPanel, farPortId: 'panel-front-7', farChassisId: 'patch-01', outsideCloset: false } })],
  });
  const dist = chassis({
    id: 'dist-01',
    ports: [port({ id: 'dist-port', label: '1', cable: { cableId: panelToDist, farPortId: 'panel-rear-12', farChassisId: 'patch-01', outsideCloset: false } })],
  });
  const patch = panel({
    id: 'patch-01',
    ports: [
      port({
        id: 'panel-front-7',
        label: '7',
        row: 0,
        passThroughId: 'pass-through:patch-01',
        cable: { cableId: accToPanel, farPortId: 'acc-port', farChassisId: 'acc-01', outsideCloset: false },
      }),
      port({
        id: 'panel-rear-12',
        label: '12',
        row: 1,
        passThroughId: 'pass-through:patch-01',
        cable: { cableId: panelToDist, farPortId: 'dist-port', farChassisId: 'dist-01', outsideCloset: false },
      }),
    ],
  });
  return {
    premisesId: 'closet-1',
    unplaced: [],
    rows: [],
    surfaces: [],
    racks: [{ id: 'rack-1', label: 'A-04', heightU: 42, unitNumbering: 'bottom-up', freeRuns: [], row: null, bay: null, shelves: [], chassis: [acc, patch, dist] }],
    cables: [
      { id: accToPanel, kind: 'copper', media: 'cat6', sheath: 'grey', label: null, ends: [{ portId: 'acc-port', chassisId: 'acc-01', rackId: 'rack-1' }, { portId: 'panel-front-7', chassisId: 'patch-01', rackId: 'rack-1' }] },
      { id: panelToDist, kind: 'copper', media: 'cat6', sheath: 'blue', label: null, ends: [{ portId: 'panel-rear-12', chassisId: 'patch-01', rackId: 'rack-1' }, { portId: 'dist-port', chassisId: 'dist-01', rackId: 'rack-1' }] },
    ],
  };
}

describe('litPathFor: two hops through a panel (passThroughId, differing labels)', () => {
  it('hovering the near cable lights both cables, in order — the label pairing would have failed here', () => {
    const path = litPathFor(panelViaPassThroughView(), 'cable-1', []);
    expect(path.cableIds).toEqual(['cable-1', 'cable-2']);
  });

  it('hovering the far cable lights the same path', () => {
    const path = litPathFor(panelViaPassThroughView(), 'cable-2', []);
    expect(path.cableIds).toEqual(['cable-1', 'cable-2']);
  });
});

/** ADR-0051 §2: the outlet box this time is a real surface fixture (a wall
 * `FixedTo`, `design/places/renders/Surfaces.png`'s own `outlet-w1`), not a
 * rack chassis the way `outletBoxView` above stands in for one — the walk
 * has to reach it through `locatePort`'s `'fixture'` place, not
 * `findAnyPort`, for the path to continue from the desk, through the
 * outlet's own `PassThrough` pair, to the panel racked in the closet. */
function fixtureOutletView(): ClosetView {
  const deskToOutlet = 'cable-1';
  const outletToPanel = 'cable-2';
  const desk = chassis({
    id: 'desk-01',
    ports: [
      port({
        id: 'desk-port',
        label: '1',
        cable: { cableId: deskToOutlet, farPortId: 'outlet-front', farChassisId: 'outlet-w1', outsideCloset: false },
      }),
    ],
  });
  const panelChassis = panel({
    id: 'patch-01',
    ports: [
      port({
        id: 'panel-port',
        label: '13',
        cable: { cableId: outletToPanel, farPortId: 'outlet-rear', farChassisId: 'outlet-w1', outsideCloset: false },
      }),
    ],
  });
  const outletFixture = {
    id: 'outlet-w1',
    kind: 'passive' as const,
    label: 'outlet-w1',
    model: null,
    form: 'outlet',
    xMm: 300,
    yMm: 1200,
    psuInlets: [],
    fixtures: [],
    ports: [
      port({
        id: 'outlet-front',
        label: 'A',
        passThroughId: 'pass-through:outlet-w1',
        cable: { cableId: deskToOutlet, farPortId: 'desk-port', farChassisId: 'desk-01', outsideCloset: false },
      }),
      port({
        id: 'outlet-rear',
        label: 'A-run',
        passThroughId: 'pass-through:outlet-w1',
        cable: { cableId: outletToPanel, farPortId: 'panel-port', farChassisId: 'patch-01', outsideCloset: false },
      }),
    ],
  };
  return {
    premisesId: 'closet-1',
    unplaced: [],
    rows: [],
    surfaces: [
      { id: 'wall-west', label: 'west wall', form: 'wall', widthMm: null, heightMm: null, fixtures: [outletFixture] },
    ],
    racks: [
      { id: 'rack-1', label: 'A-04', heightU: 42, unitNumbering: 'bottom-up', freeRuns: [], row: null, bay: null, shelves: [], chassis: [desk, panelChassis] },
    ],
    // `outlet-w1` is `FixedTo` the wall, never `MountedIn` a rack —
    // `rackId: null` on its own ends is what `document/view.ts`'s own
    // `cableEnd` actually produces for a surface fixture (`placementOf`'s
    // `'surface'` case has no rack); a rack id here would be a shape this
    // seam never emits.
    cables: [
      { id: deskToOutlet, kind: 'copper', media: 'cat6', sheath: 'grey', label: null, ends: [{ portId: 'desk-port', chassisId: 'desk-01', rackId: 'rack-1' }, { portId: 'outlet-front', chassisId: 'outlet-w1', rackId: null }] },
      { id: outletToPanel, kind: 'copper', media: 'cat6', sheath: 'blue', label: null, ends: [{ portId: 'outlet-rear', chassisId: 'outlet-w1', rackId: null }, { portId: 'panel-port', chassisId: 'patch-01', rackId: 'rack-1' }] },
    ],
  };
}

describe('litPathFor: through an outlet box that is a surface fixture, not a chassis (ADR-0051 §2)', () => {
  it('hovering the desk-to-outlet cable lights through the outlet\'s own pass-through to the panel', () => {
    const path = litPathFor(fixtureOutletView(), 'cable-1', []);
    expect(path.cableIds).toEqual(['cable-1', 'cable-2']);
  });

  it('hovering the outlet-to-panel cable lights the same path', () => {
    const path = litPathFor(fixtureOutletView(), 'cable-2', []);
    expect(path.cableIds).toEqual(['cable-1', 'cable-2']);
  });
});
