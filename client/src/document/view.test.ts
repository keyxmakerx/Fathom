import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../api/catalogue';
import { addSketchPort, createRack, createShelf, createSurface, fixTo, movePlacement, placeChassis, placeOnShelf } from './commands';
import { setRackField } from './edit';
import { edgesIn, edgesOut, emptyDocument, formatEdgeId, formatNodeId, type Document } from './model';
import { fitSupply, removeSupply } from './supplies';
import { newUlid } from './ulid';
import { viewOf } from './view';

const NOW = 1_700_000_000_000;

const MODEL: CatalogueModel = {
  vendor: 'juniper',
  model: 'EX4300-48P',
  rackUnits: 1,
  reviewedBy: 'reviewer',
  source: { cite: 'cite', readOn: '2026-09-14' },
  psuSlots: [],
  faceplates: [
    {
      face: 'front',
      portCount: 2,
      ports: [
        { kind: 'RJ45', number: 0, uplink: false, role: 'access', row: 'top', column: 0, groupGapBefore: false },
        { kind: 'RJ45', number: 1, uplink: false, role: 'access', row: 'bottom', column: 0, groupGapBefore: false },
      ],
    },
    {
      face: 'rear',
      portCount: 1,
      ports: [{ kind: 'QSFP+', number: 0, uplink: true, role: 'uplink', row: 'single', column: 0, groupGapBefore: false }],
    },
  ],
};

const MODEL_WITH_PSU: CatalogueModel = {
  ...MODEL,
  psuSlots: [
    { name: 'PSU0', hotSwap: true, face: 'rear', position: { row: 'single', column: 0 } },
    { name: 'PSU1', hotSwap: true, face: 'rear', position: { row: 'single', column: 1 } },
  ],
};

const MODEL_WITH_FIXED_PSU: CatalogueModel = {
  ...MODEL,
  psuSlots: [{ name: 'PSU0', hotSwap: false, face: 'rear', position: { row: 'single', column: 0 } }],
};

function premisesDoc(): { doc: Document; premisesId: string } {
  const premisesId = formatNodeId('Premises', newUlid(NOW));
  const doc: Document = {
    ...emptyDocument(),
    nodes: [
      {
        id: premisesId,
        existence: newUlid(NOW),
        fields: { 'Premises.label': { presence: 'set', prov: newUlid(NOW), value: 'Riverside CO' } },
      },
    ],
  };
  return { doc, premisesId };
}

describe('viewOf', () => {
  it('is empty for a document with no Premises', () => {
    expect(viewOf(emptyDocument(), [])).toEqual({ premisesId: '', racks: [], cables: [], rows: [], surfaces: [] });
  });

  it('draws a rack with no chassis and one free run', () => {
    const { doc, premisesId } = premisesDoc();
    const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 10, unitNumbering: 'ascending', now: NOW });
    const view = viewOf(withRack, []);
    expect(view.premisesId).toBe(premisesId);
    expect(view.racks).toHaveLength(1);
    expect(view.racks[0]).toMatchObject({
      label: 'R1',
      heightU: 10,
      unitNumbering: 'ascending',
      chassis: [],
      row: null,
      bay: null,
    });
    expect(view.racks[0].freeRuns).toEqual([{ fromU: 1, toU: 10 }]);
  });

  it('draws a mounted chassis, its catalogue-sourced height, and BOTH faceplates’ ports, each tagged with its own face', () => {
    const { doc, premisesId } = premisesDoc();
    const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 10, unitNumbering: 'ascending', now: NOW });
    const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
    const placed = placeChassis(withRack, rackId, MODEL, 3, 'front', { now: NOW });

    const view = viewOf(placed, [MODEL]);
    expect(view.racks[0].chassis).toHaveLength(1);
    const chassis = view.racks[0].chassis[0];
    expect(chassis.model).toBe('EX4300-48P');
    expect(chassis.vendor).toBe('juniper');
    expect(chassis.positionU).toBe(3);
    expect(chassis.heightU).toBe(1);
    expect(chassis.face).toBe('front'); // the MOUNTING face
    // Both the front (2 ports) and rear (1 port) faceplates are drawn now,
    // regardless of which face the chassis is mounted on (ADR-0050 §1).
    expect(chassis.ports).toHaveLength(3);
    const front = chassis.ports.filter((p) => p.face === 'front');
    const rear = chassis.ports.filter((p) => p.face === 'rear');
    expect(front.map((p) => p.label).sort()).toEqual(['0', '1']);
    expect(rear.map((p) => p.label)).toEqual(['0']);
    // The schema's token, never the catalogue's `"RJ45"` (`compat.ts`'s `connectorTokenOf`).
    expect(front.every((p) => p.connector === 'rj45')).toBe(true);
    expect(rear[0].connector).toBe('qsfp');
    // role/uplink derive from the catalogue's own role.
    expect(front.every((p) => p.role === 'access' && p.uplink === false)).toBe(true);
    expect(rear[0].role).toBe('uplink');
    expect(rear[0].uplink).toBe(true);

    expect(view.racks[0].freeRuns).toEqual([
      { fromU: 1, toU: 2 },
      { fromU: 4, toU: 10 },
    ]);
  });

  it('falls back to MountedIn.height_u when the catalogue has no matching model', () => {
    const { doc, premisesId } = premisesDoc();
    const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 10, unitNumbering: 'ascending', now: NOW });
    const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
    const placed = placeChassis(withRack, rackId, MODEL, 3, 'front', { now: NOW });

    const view = viewOf(placed, []); // no catalogue entry supplied
    expect(view.racks[0].chassis[0].heightU).toBe(1); // MountedIn.height_u, set at placement
    expect(view.racks[0].chassis[0].vendor).toBe('');
  });

  it('draws a fixed PSU slot’s inlet as always fitted, with no PowerSupply', () => {
    const { doc, premisesId } = premisesDoc();
    const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 10, unitNumbering: 'ascending', now: NOW });
    const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
    const placed = placeChassis(withRack, rackId, MODEL_WITH_FIXED_PSU, 3, 'front', { now: NOW });

    const view = viewOf(placed, [MODEL_WITH_FIXED_PSU]);
    const chassis = view.racks[0].chassis[0];
    expect(chassis.psuInlets).toHaveLength(1);
    expect(chassis.psuInlets[0]).toMatchObject({ slot: 'PSU0', hotSwap: false, fitted: true, supplyId: null, face: 'rear' });
    expect(chassis.singleFed).toBe(false); // only one slot at all
    expect(chassis.oneFitted).toBe(false); // nothing empty, and only one slot
  });

  describe('hot-swap PSU inlets (ADR-0050 §4)', () => {
    function placedWithPsu(): { doc: Document; chassisId: string; rackId: string } {
      const { doc, premisesId } = premisesDoc();
      const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 10, unitNumbering: 'ascending', now: NOW });
      const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
      const placed = placeChassis(withRack, rackId, MODEL_WITH_PSU, 3, 'front', { now: NOW });
      const view = viewOf(placed, [MODEL_WITH_PSU]);
      const chassisId = view.racks[0].chassis[0].id;
      return { doc: placed, chassisId, rackId };
    }

    it('both slots fitted, neither cabled: not single-fed, not one-fitted', () => {
      const { doc } = placedWithPsu();
      const view = viewOf(doc, [MODEL_WITH_PSU]);
      const chassis = view.racks[0].chassis[0];
      expect(chassis.psuInlets).toHaveLength(2);
      expect(chassis.psuInlets.every((i) => i.fitted && i.hotSwap && i.supplyId != null)).toBe(true);
      expect(chassis.singleFed).toBe(false);
      expect(chassis.oneFitted).toBe(false);
    });

    it('removeSupply empties a slot: fitted: false, synthetic id, one-fitted true', () => {
      const { doc, chassisId } = placedWithPsu();
      const view0 = viewOf(doc, [MODEL_WITH_PSU]);
      const supplyId = view0.racks[0].chassis[0].psuInlets.find((i) => i.slot === 'PSU0')!.supplyId!;

      const removed = removeSupply(doc, supplyId, { now: NOW });
      const view = viewOf(removed, [MODEL_WITH_PSU]);
      const chassis = view.racks[0].chassis[0];
      const psu0 = chassis.psuInlets.find((i) => i.slot === 'PSU0')!;
      const psu1 = chassis.psuInlets.find((i) => i.slot === 'PSU1')!;
      expect(psu0.fitted).toBe(false);
      expect(psu0.supplyId).toBeNull();
      expect(psu0.cable).toBeNull();
      expect(psu0.id).toBe(`slot:${chassisId}:PSU0`);
      expect(psu1.fitted).toBe(true);
      expect(chassis.oneFitted).toBe(true);
      expect(chassis.singleFed).toBe(false); // fitted count dropped to 1 — too few to be single-fed
    });

    it('fitSupply refits an emptied slot', () => {
      const { doc } = placedWithPsu();
      const view0 = viewOf(doc, [MODEL_WITH_PSU]);
      const supplyId = view0.racks[0].chassis[0].psuInlets.find((i) => i.slot === 'PSU0')!.supplyId!;
      const chassisId = view0.racks[0].chassis[0].id;

      const removed = removeSupply(doc, supplyId, { now: NOW });
      const refitted = fitSupply(removed, chassisId, 'PSU0', { serial: 'SN123' }, { now: NOW });
      const view = viewOf(refitted, [MODEL_WITH_PSU]);
      const psu0 = view.racks[0].chassis[0].psuInlets.find((i) => i.slot === 'PSU0')!;
      expect(psu0.fitted).toBe(true);
      expect(psu0.hotSwap).toBe(true);
      expect(psu0.supplyId).not.toBeNull();
      expect(psu0.serial).toBe('SN123');
    });
  });

  describe('rows (ADR-0050 §2)', () => {
    it('groups named rows by label, numerically aware, bays ascending; unrowed racks after, each its own row', () => {
      const { doc, premisesId } = premisesDoc();
      let working = createRack(doc, premisesId, { label: 'R-unrowed', heightU: 10, unitNumbering: 'ascending', now: NOW });
      const unrowedId = working.nodes.find((n) => n.id !== premisesId)!.id;

      working = createRack(working, premisesId, { label: 'R-A-2', heightU: 10, unitNumbering: 'ascending', now: NOW });
      const aBay2Id = working.nodes.find((n) => n.id !== premisesId && n.id !== unrowedId)!.id;
      working = setRackField(working, aBay2Id, 'row', 'Row A', { now: NOW });
      working = setRackField(working, aBay2Id, 'bay', 2, { now: NOW });

      working = createRack(working, premisesId, { label: 'R-A-1', heightU: 10, unitNumbering: 'ascending', now: NOW });
      const aBay1Id = working.nodes.find(
        (n) => n.id !== premisesId && n.id !== unrowedId && n.id !== aBay2Id,
      )!.id;
      working = setRackField(working, aBay1Id, 'row', 'Row A', { now: NOW });
      working = setRackField(working, aBay1Id, 'bay', 1, { now: NOW });

      working = createRack(working, premisesId, { label: 'R-B-1', heightU: 10, unitNumbering: 'ascending', now: NOW });
      const bBay1Id = working.nodes.find(
        (n) => n.id !== premisesId && n.id !== unrowedId && n.id !== aBay2Id && n.id !== aBay1Id,
      )!.id;
      working = setRackField(working, bBay1Id, 'row', 'Row B', { now: NOW });
      working = setRackField(working, bBay1Id, 'bay', 1, { now: NOW });

      const view = viewOf(working, []);
      expect(view.rows.map((r) => r.label)).toEqual(['Row A', 'Row B', null]);
      expect(view.rows[0].racks.map((r) => r.id)).toEqual([aBay1Id, aBay2Id]); // bay ascending
      expect(view.rows[1].racks.map((r) => r.id)).toEqual([bBay1Id]);
      expect(view.rows[2]).toEqual({ label: null, racks: [expect.objectContaining({ id: unrowedId })] });
    });
  });
});

// ===========================================================================
// ADR-0051 §1 — shelves, surfaces, the sketch.

function bareChassis(doc: Document): { doc: Document; chassisId: string } {
  const deviceId = formatNodeId('Device', newUlid(NOW));
  const chassisId = formatNodeId('Chassis', newUlid(NOW));
  const next: Document = {
    ...doc,
    nodes: [
      ...doc.nodes,
      { id: deviceId, existence: newUlid(NOW), fields: {} },
      { id: chassisId, existence: newUlid(NOW), fields: {} },
    ],
    edges: [
      ...doc.edges,
      { id: formatEdgeId('HasChassis', newUlid(NOW)), from: deviceId, to: chassisId, prov: newUlid(NOW), fields: {} },
    ],
  };
  return { doc: next, chassisId };
}

describe('shelves (ADR-0051 §1)', () => {
  it('draws separately from chassis[], occupants sorted by slot', () => {
    const { doc, premisesId } = premisesDoc();
    const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', now: NOW });
    const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
    const withShelf = createShelf(withRack, rackId, { label: 'Shelf', positionU: 20, now: NOW });
    const shelfId = edgesIn(withShelf, rackId, 'MountedIn')[0].from;

    const { doc: withItem1, chassisId: item1 } = bareChassis(withShelf);
    const onShelf1 = placeOnShelf(withItem1, item1, shelfId, 2, { now: NOW });
    const { doc: withItem2, chassisId: item2 } = bareChassis(onShelf1);
    const onShelf2 = placeOnShelf(withItem2, item2, shelfId, 1, { now: NOW });

    const view = viewOf(onShelf2, []);
    const rack = view.racks[0];
    expect(rack.chassis).toHaveLength(0); // a shelf is never also in chassis[]
    expect(rack.shelves).toHaveLength(1);
    const shelf = rack.shelves[0];
    expect(shelf.id).toBe(shelfId);
    expect(shelf.positionU).toBe(20);
    expect(shelf.heightU).toBe(1);
    expect(shelf.occupants.map((o) => o.slot)).toEqual([1, 2]);
    expect(shelf.occupants.map((o) => o.id)).toEqual([item2, item1]);
    expect(shelf.occupants.every((o) => o.kind === 'chassis')).toBe(true);
  });

  it('a shelf occupant with no model and at least one port is sketch: true', () => {
    const { doc, premisesId } = premisesDoc();
    const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', now: NOW });
    const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
    const withShelf = createShelf(withRack, rackId, { label: 'Shelf', positionU: 20, now: NOW });
    const shelfId = edgesIn(withShelf, rackId, 'MountedIn')[0].from;
    const { doc: withItem, chassisId } = bareChassis(withShelf);
    const withPort = addSketchPort(withItem, chassisId, { label: 'eth0', connector: 'rj45', face: 'front' }, { now: NOW });
    const onShelf = placeOnShelf(withPort, chassisId, shelfId, 1, { now: NOW });

    const view = viewOf(onShelf, []);
    const occupant = view.racks[0].shelves[0].occupants[0];
    expect(occupant.sketch).toBe(true);
    expect(occupant.ports).toHaveLength(1);
    expect(occupant.ports[0]).toMatchObject({ label: 'eth0', connector: 'rj45', face: 'front', passThroughId: null });
  });

  it('a shelf occupant\'s own C14 port is drawn in ports — OccupantView has no separate psuInlets to route it to (ADR-0051 §1)', () => {
    const { doc, premisesId } = premisesDoc();
    const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', now: NOW });
    const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
    const withShelf = createShelf(withRack, rackId, { label: 'Shelf', positionU: 20, now: NOW });
    const shelfId = edgesIn(withShelf, rackId, 'MountedIn')[0].from;
    const { doc: withItem, chassisId } = bareChassis(withShelf);
    const withEth = addSketchPort(withItem, chassisId, { label: 'eth0', connector: 'rj45', face: 'front' }, { now: NOW });
    const withInlet = addSketchPort(withEth, chassisId, { label: 'inlet', connector: 'c14', face: 'rear' }, { now: NOW });
    const onShelf = placeOnShelf(withInlet, chassisId, shelfId, 1, { now: NOW });

    const view = viewOf(onShelf, []);
    const occupant = view.racks[0].shelves[0].occupants[0];
    expect(occupant.ports.map((p) => p.connector)).toEqual(expect.arrayContaining(['rj45', 'c14']));
    expect(occupant.ports.find((p) => p.connector === 'c14')).toMatchObject({ label: 'inlet', face: 'rear' });
  });

  it('a catalogue chassis is never sketch', () => {
    const { doc, premisesId } = premisesDoc();
    const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 10, unitNumbering: 'ascending', now: NOW });
    const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
    const placed = placeChassis(withRack, rackId, MODEL, 3, 'front', { now: NOW });
    const view = viewOf(placed, [MODEL]);
    expect(view.racks[0].chassis[0].sketch).toBe(false);
  });
});

describe('ChassisView.placement (ADR-0051 §1)', () => {
  it('reflects the live MountedIn edge, then the live FixedTo after a move', () => {
    const { doc, premisesId } = premisesDoc();
    const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 10, unitNumbering: 'ascending', now: NOW });
    const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
    const placed = placeChassis(withRack, rackId, MODEL, 3, 'front', { now: NOW });
    const view1 = viewOf(placed, [MODEL]);
    expect(view1.racks[0].chassis[0].placement).toEqual({ kind: 'rack', rackId, positionU: 3, face: 'front' });

    const chassisId = view1.racks[0].chassis[0].id;
    const withSurface = createSurface(placed, premisesId, { label: 'Floor', form: 'floor', now: NOW });
    const surfaceId = edgesOut(withSurface, premisesId, 'HasSurface')[0].to;
    const moved = movePlacement(withSurface, chassisId, { kind: 'surface', surfaceId, xMm: 10, yMm: null }, { now: NOW });

    const view2 = viewOf(moved, [MODEL]);
    expect(view2.racks[0].chassis).toHaveLength(0);
    const fixture = view2.surfaces.find((s) => s.id === surfaceId)!.fixtures[0];
    expect(fixture.xMm).toBe(10);
    expect(fixture.yMm).toBeNull();
  });
});

describe('ClosetView.surfaces (ADR-0051 §1)', () => {
  it('is empty when there is a premises but no surfaces', () => {
    const { doc } = premisesDoc();
    expect(viewOf(doc, []).surfaces).toEqual([]);
  });

  it('draws a wall, a board fixed to it, and an outlet fixed to the board — nested fixtures', () => {
    const { doc, premisesId } = premisesDoc();
    const withSurface = createSurface(doc, premisesId, { label: 'North wall', form: 'wall', widthMm: 2400, now: NOW });
    const surfaceId = edgesOut(withSurface, premisesId, 'HasSurface')[0].to;

    const boardId = formatNodeId('PassiveNode', newUlid(NOW));
    let working: Document = {
      ...withSurface,
      nodes: [
        ...withSurface.nodes,
        {
          id: boardId,
          existence: newUlid(NOW),
          fields: {
            'PassiveNode.form': { presence: 'set', prov: newUlid(NOW), value: 'board' },
            'PassiveNode.label': { presence: 'set', prov: newUlid(NOW), value: 'Backboard' },
          },
        },
      ],
    };
    working = fixTo(working, boardId, surfaceId, {}, { now: NOW });

    const outletId = formatNodeId('PassiveNode', newUlid(NOW));
    working = {
      ...working,
      nodes: [
        ...working.nodes,
        {
          id: outletId,
          existence: newUlid(NOW),
          fields: {
            'PassiveNode.form': { presence: 'set', prov: newUlid(NOW), value: 'outlet' },
            'PassiveNode.label': { presence: 'set', prov: newUlid(NOW), value: 'outlet-w1' },
          },
        },
      ],
    };
    working = fixTo(working, outletId, boardId, { xMm: 100, yMm: 200 }, { now: NOW });

    const view = viewOf(working, []);
    expect(view.surfaces).toHaveLength(1);
    const surface = view.surfaces[0];
    expect(surface).toMatchObject({ id: surfaceId, label: 'North wall', form: 'wall', widthMm: 2400, heightMm: null });
    expect(surface.fixtures).toHaveLength(1);
    const board = surface.fixtures[0];
    expect(board).toMatchObject({ id: boardId, kind: 'passive', form: 'board', xMm: null, yMm: null });
    expect(board.fixtures).toHaveLength(1);
    const outlet = board.fixtures[0];
    expect(outlet).toMatchObject({ id: outletId, kind: 'passive', form: 'outlet', xMm: 100, yMm: 200 });
  });

  it('a floor-standing UPS draws as a fixture with its own psuInlets, cabled like a chassis', () => {
    const { doc, premisesId } = premisesDoc();
    const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 10, unitNumbering: 'ascending', now: NOW });
    const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
    const placed = placeChassis(withRack, rackId, MODEL_WITH_PSU, 3, 'front', { now: NOW });
    const chassisId = edgesIn(placed, rackId, 'MountedIn')[0].from;
    const withFloor = createSurface(placed, premisesId, { label: 'Floor', form: 'floor', now: NOW });
    const floorId = edgesOut(withFloor, premisesId, 'HasSurface')[0].to;
    const moved = movePlacement(withFloor, chassisId, { kind: 'surface', surfaceId: floorId, xMm: null, yMm: null }, { now: NOW });

    const view = viewOf(moved, [MODEL_WITH_PSU]);
    const fixture = view.surfaces[0].fixtures[0];
    expect(fixture.kind).toBe('chassis');
    expect(fixture.psuInlets).toHaveLength(2);
  });
});
