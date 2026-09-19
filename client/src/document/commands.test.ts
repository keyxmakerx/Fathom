import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../api/catalogue';
import { FieldValueError } from './edit';
import {
  AlreadyPlacedError,
  InvalidFixedToTargetError,
  NotAShelfError,
  RackOverlapError,
  RackRangeError,
  SketchOnCatalogueChassisError,
  SlotTakenError,
  UnknownReferenceError,
  addSketchPort,
  createBoard,
  createRack,
  createShelf,
  createSketchDevice,
  createSurface,
  fixTo,
  moveChassis,
  movePlacement,
  placeChassis,
  placeOnShelf,
  removeChassis,
  removeSketchPort,
} from './commands';
import {
  edgesIn,
  edgesOut,
  emptyDocument,
  findNode,
  formatEdgeId,
  formatNodeId,
  readChassisFields,
  readFixedToFields,
  readMountedInFields,
  readPassiveNodeFields,
  readPhysicalPortFields,
  readPowerSupplyFields,
  readRackFields,
  readSitsOnFields,
  readSurfaceFields,
  type Document,
} from './model';
import { newUlid } from './ulid';
import { viewOf } from './view';

const NOW = 1_700_000_000_000;

function docWithPremises(): { doc: Document; premisesId: string } {
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

const MODEL_1U: CatalogueModel = {
  vendor: 'juniper',
  model: 'EX4300-48P',
  rackUnits: 1,
  reviewedBy: 'reviewer',
  source: { cite: 'cite', readOn: '2026-09-14' },
  psuSlots: [
    { name: 'PSU0', hotSwap: true, face: 'rear', position: { row: 'single', column: 0 } },
    { name: 'PSU1', hotSwap: true, face: 'rear', position: { row: 'single', column: 1 } },
  ],
  faceplates: [
    {
      face: 'front',
      portCount: 2,
      ports: [
        { kind: 'RJ45', number: 0, uplink: false, row: 'top', column: 0, groupGapBefore: false },
        { kind: 'RJ45', number: 1, uplink: false, row: 'bottom', column: 0, groupGapBefore: false },
      ],
    },
    {
      face: 'rear',
      portCount: 1,
      ports: [{ kind: 'QSFP+', number: 0, uplink: true, row: 'single', column: 0, groupGapBefore: false }],
    },
  ],
};

describe('createRack', () => {
  it('creates a Rack owned by the given Premises', () => {
    const { doc, premisesId } = docWithPremises();
    const next = createRack(doc, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', now: NOW });
    expect(next.nodes).toHaveLength(2);
    const rack = next.nodes.find((n) => n.id !== premisesId)!;
    expect(readRackFields(rack)).toEqual({ label: 'R1', heightU: 42, unitNumbering: 'ascending' });
    const hasRack = edgesOut(next, premisesId, 'HasRack');
    expect(hasRack).toHaveLength(1);
    expect(hasRack[0].to).toBe(rack.id);
    expect(next.batches).toHaveLength(1);
    expect(next.batches[0].ops[0]).toEqual({ type: 'add_node', node: rack.id, prov: rack.existence });
  });

  it('refuses an unknown premises', () => {
    const { doc } = docWithPremises();
    expect(() =>
      createRack(doc, 'premises:01ARZ3NDEKTSV4RRFFQ69G5FAV', {
        label: 'R1',
        heightU: 42,
        unitNumbering: 'ascending',
        now: NOW,
      }),
    ).toThrow(UnknownReferenceError);
  });

  it('does not mutate its input', () => {
    const { doc, premisesId } = docWithPremises();
    const before = JSON.stringify(doc);
    createRack(doc, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', now: NOW });
    expect(JSON.stringify(doc)).toBe(before);
  });
});

function rackOf(heightU: number): { doc: Document; premisesId: string; rackId: string } {
  const { doc, premisesId } = docWithPremises();
  const withRack = createRack(doc, premisesId, { label: 'R1', heightU, unitNumbering: 'ascending', now: NOW });
  const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
  return { doc: withRack, premisesId, rackId };
}

describe('placeChassis', () => {
  it('creates the Device, Chassis, its ports and the MountedIn edge', () => {
    const { doc, rackId } = rackOf(42);
    const next = placeChassis(doc, rackId, MODEL_1U, 12, 'front', { now: NOW });

    const mounted = edgesIn(next, rackId, 'MountedIn');
    expect(mounted).toHaveLength(1);
    expect(readMountedInFields(mounted[0])).toEqual({ positionU: 12, heightU: 1, face: 'front' });

    const chassisId = mounted[0].from;
    expect(readChassisFields(findNode(next, chassisId)!)).toEqual({ model: 'EX4300-48P', serial: undefined });

    const hasChassis = edgesIn(next, chassisId, 'HasChassis');
    expect(hasChassis).toHaveLength(1);
    const deviceId = hasChassis[0].from;
    expect(findNode(next, deviceId)).toBeDefined();

    const ports = edgesOut(next, chassisId, 'HasPort');
    // 2 front + 1 rear faceplate ports. MODEL_1U's two PSU slots are both
    // `hotSwap: true` (ADR-0050 §4), so their inlets live on fresh
    // `PowerSupply` nodes, not as `HasPort` children of the chassis itself.
    expect(ports).toHaveLength(3);

    const fitted = edgesOut(next, chassisId, 'FittedIn');
    expect(fitted).toHaveLength(2);
    for (const f of fitted) {
      const supply = findNode(next, f.to)!;
      expect(readPowerSupplyFields(supply).slot).toMatch(/^PSU[01]$/);
      const supplyPorts = edgesOut(next, f.to, 'HasPort');
      expect(supplyPorts).toHaveLength(1);
      const inlet = findNode(next, supplyPorts[0].to)!;
      const inletFields = readPhysicalPortFields(inlet);
      expect(inletFields.connector).toBe('c14');
      expect(inletFields.label).toBe(readPowerSupplyFields(supply).slot);
    }
  });

  it('keeps a fixed (non-hot-swap) slot\'s inlet directly on the chassis', () => {
    const { doc, rackId } = rackOf(42);
    const fixedModel: CatalogueModel = {
      ...MODEL_1U,
      psuSlots: [{ name: 'PSU0', hotSwap: false, face: 'rear', position: { row: 'single', column: 0 } }],
    };
    const next = placeChassis(doc, rackId, fixedModel, 12, 'front', { now: NOW });
    const mounted = edgesIn(next, rackId, 'MountedIn')[0];
    const chassisId = mounted.from;

    expect(edgesOut(next, chassisId, 'FittedIn')).toHaveLength(0);
    const ports = edgesOut(next, chassisId, 'HasPort');
    const inlet = ports.find((e) => readPhysicalPortFields(findNode(next, e.to)!).connector === 'c14');
    expect(inlet).toBeDefined();
    expect(readPhysicalPortFields(findNode(next, inlet!.to)!).label).toBe('PSU0');
  });

  it('labels a named port with its catalogue name, not "null"', () => {
    const { doc, rackId } = rackOf(42);
    const namedModel: CatalogueModel = {
      ...MODEL_1U,
      psuSlots: [],
      faceplates: [
        {
          face: 'front',
          portCount: 1,
          ports: [{ kind: 'RJ45', number: null, name: 'me0', uplink: false, role: 'management', row: 'single', column: 0, groupGapBefore: false }],
        },
      ],
    };
    const next = placeChassis(doc, rackId, namedModel, 12, 'front', { now: NOW });
    const chassisId = edgesIn(next, rackId, 'MountedIn')[0].from;
    const port = edgesOut(next, chassisId, 'HasPort')[0];
    expect(readPhysicalPortFields(findNode(next, port.to)!).label).toBe('me0');
  });

  it('refuses an out-of-range unit', () => {
    const { doc, rackId } = rackOf(10);
    expect(() => placeChassis(doc, rackId, MODEL_1U, 10, 'front', { now: NOW })).not.toThrow();
    expect(() => placeChassis(doc, rackId, MODEL_1U, 11, 'front', { now: NOW })).toThrow(RackRangeError);
    expect(() => placeChassis(doc, rackId, MODEL_1U, 0, 'front', { now: NOW })).toThrow(RackRangeError);
  });

  it('refuses two chassis on the same unit', () => {
    const { doc, rackId } = rackOf(42);
    const once = placeChassis(doc, rackId, MODEL_1U, 12, 'front', { now: NOW });
    expect(() => placeChassis(once, rackId, MODEL_1U, 12, 'front', { now: NOW })).toThrow(RackOverlapError);
  });

  it('allows adjacent, non-overlapping placement', () => {
    const { doc, rackId } = rackOf(42);
    const once = placeChassis(doc, rackId, MODEL_1U, 12, 'front', { now: NOW });
    expect(() => placeChassis(once, rackId, MODEL_1U, 13, 'front', { now: NOW })).not.toThrow();
  });
});

describe('moveChassis', () => {
  it('updates position and face within the same rack', () => {
    const { doc, rackId } = rackOf(42);
    const placed = placeChassis(doc, rackId, MODEL_1U, 12, 'front', { now: NOW });
    const chassisId = edgesIn(placed, rackId, 'MountedIn')[0].from;
    const moved = moveChassis(placed, chassisId, rackId, 20, 'rear', { now: NOW });
    const mounted = edgesOut(moved, chassisId, 'MountedIn')[0];
    expect(readMountedInFields(mounted)).toEqual({ positionU: 20, heightU: 1, face: 'rear' });
    expect(mounted.to).toBe(rackId);
  });

  it('refuses an overlap with another chassis in the same rack', () => {
    const { doc, rackId } = rackOf(42);
    let working = placeChassis(doc, rackId, MODEL_1U, 12, 'front', { now: NOW });
    working = placeChassis(working, rackId, MODEL_1U, 13, 'front', { now: NOW });
    const first = edgesIn(working, rackId, 'MountedIn').find((e) => readMountedInFields(e).positionU === 12)!;
    expect(() => moveChassis(working, first.from, rackId, 13, 'front', { now: NOW })).toThrow(RackOverlapError);
  });

  it('refuses an unknown chassis', () => {
    const { doc, rackId } = rackOf(42);
    expect(() =>
      moveChassis(doc, 'chassis:01ARZ3NDEKTSV4RRFFQ69G5FAV', rackId, 1, 'front', { now: NOW }),
    ).toThrow(UnknownReferenceError);
  });

  it('moves a chassis from one rack to another', () => {
    const { doc, premisesId, rackId: sourceRackId } = rackOf(42);
    const withTarget = createRack(doc, premisesId, {
      label: 'R2',
      heightU: 42,
      unitNumbering: 'ascending',
      now: NOW,
    });
    const targetRackId = withTarget.nodes.find((n) => n.id !== premisesId && n.id !== sourceRackId)!.id;
    const placed = placeChassis(withTarget, sourceRackId, MODEL_1U, 12, 'front', { now: NOW });
    const chassisId = edgesIn(placed, sourceRackId, 'MountedIn')[0].from;

    const moved = moveChassis(placed, chassisId, targetRackId, 20, 'rear', { now: NOW });

    expect(edgesIn(moved, sourceRackId, 'MountedIn')).toHaveLength(0);
    const mounted = edgesIn(moved, targetRackId, 'MountedIn');
    expect(mounted).toHaveLength(1);
    expect(mounted[0].from).toBe(chassisId);
    expect(readMountedInFields(mounted[0])).toEqual({ positionU: 20, heightU: 1, face: 'rear' });

    const view = viewOf(moved, [MODEL_1U]);
    const sourceView = view.racks.find((r) => r.id === sourceRackId)!;
    const targetView = view.racks.find((r) => r.id === targetRackId)!;
    expect(sourceView.chassis).toHaveLength(0);
    expect(sourceView.freeRuns).toEqual([{ fromU: 1, toU: 42 }]);
    expect(targetView.chassis).toHaveLength(1);
    expect(targetView.chassis[0].id).toBe(chassisId);
    expect(targetView.chassis[0].positionU).toBe(20);
  });

  it('refuses a cross-rack move onto an occupied run, leaving the document unchanged', () => {
    const { doc, premisesId, rackId: sourceRackId } = rackOf(42);
    const withTarget = createRack(doc, premisesId, {
      label: 'R2',
      heightU: 42,
      unitNumbering: 'ascending',
      now: NOW,
    });
    const targetRackId = withTarget.nodes.find((n) => n.id !== premisesId && n.id !== sourceRackId)!.id;
    let working = placeChassis(withTarget, sourceRackId, MODEL_1U, 12, 'front', { now: NOW });
    working = placeChassis(working, targetRackId, MODEL_1U, 20, 'front', { now: NOW });
    const chassisId = edgesIn(working, sourceRackId, 'MountedIn')[0].from;

    const before = JSON.stringify(working);
    expect(() => moveChassis(working, chassisId, targetRackId, 20, 'front', { now: NOW })).toThrow(
      RackOverlapError,
    );
    expect(JSON.stringify(working)).toBe(before);
  });

  it('refuses a move to an unknown rack', () => {
    const { doc, rackId } = rackOf(42);
    const placed = placeChassis(doc, rackId, MODEL_1U, 12, 'front', { now: NOW });
    const chassisId = edgesIn(placed, rackId, 'MountedIn')[0].from;
    expect(() =>
      moveChassis(placed, chassisId, 'rack:01ARZ3NDEKTSV4RRFFQ69G5FAV', 20, 'front', { now: NOW }),
    ).toThrow(UnknownReferenceError);
  });
});

describe('removeChassis', () => {
  it('marks the device, chassis, ports and their edges absent', () => {
    const { doc, rackId } = rackOf(42);
    const placed = placeChassis(doc, rackId, MODEL_1U, 12, 'front', { now: NOW });
    const mounted = edgesIn(placed, rackId, 'MountedIn')[0];
    const chassisId = mounted.from;
    const hasChassis = edgesIn(placed, chassisId, 'HasChassis')[0];
    const deviceId = hasChassis.from;
    const ports = edgesOut(placed, chassisId, 'HasPort').map((e) => e.to);

    const removed = removeChassis(placed, chassisId, { now: NOW });

    expect(removed.nodes.find((n) => n.id === deviceId)?.absentSince).toBe(NOW);
    expect(removed.nodes.find((n) => n.id === chassisId)?.absentSince).toBe(NOW);
    for (const portId of ports) {
      expect(removed.nodes.find((n) => n.id === portId)?.absentSince).toBe(NOW);
    }
    expect(removed.edges.find((e) => e.id === mounted.id)?.absentSince).toBe(NOW);
    expect(removed.edges.find((e) => e.id === hasChassis.id)?.absentSince).toBe(NOW);

    // A rack it once occupied is free again.
    expect(edgesIn(removed, rackId, 'MountedIn')).toHaveLength(0);
  });

  it('refuses an unknown chassis', () => {
    const { doc } = rackOf(42);
    expect(() => removeChassis(doc, 'chassis:01ARZ3NDEKTSV4RRFFQ69G5FAV', { now: NOW })).toThrow(
      UnknownReferenceError,
    );
  });
});

describe('placeChassis writes the schema connector token, not the catalogue kind', () => {
  it('maps RJ45 to rj45 and QSFP+ to qsfp, and an unknown kind to other', async () => {
    const { connectorTokenOf } = await import('./compat');
    expect(connectorTokenOf('RJ45')).toBe('rj45');
    expect(connectorTokenOf('SFP+')).toBe('sfp_plus');
    expect(connectorTokenOf('QSFP+')).toBe('qsfp');
    expect(connectorTokenOf('LC')).toBe('lc');
    expect(connectorTokenOf('C14')).toBe('c14');
    expect(connectorTokenOf('Mystery')).toBe('other');
  });

  it('maps the catalogue NEMA 5-15 tokens to the schema spelling (ADR-0051 §1)', async () => {
    const { connectorTokenOf } = await import('./compat');
    expect(connectorTokenOf('nema_5_15r')).toBe('nema515r');
    expect(connectorTokenOf('nema_5_15p')).toBe('nema515p');
  });
});

describe('compatible() reached from a catalogue-sourced NEMA port, not just the schema spelling', () => {
  it('accepts the pair once run through connectorTokenOf, the path placement actually takes', async () => {
    const { connectorTokenOf } = await import('./compat');
    const { compatible } = await import('./compat');
    const r = connectorTokenOf('nema_5_15r');
    const p = connectorTokenOf('nema_5_15p');
    expect(compatible(r, p)).toEqual({ ok: true, kind: 'power', media: 'power' });
    expect(compatible(p, r)).toEqual({ ok: true, kind: 'power', media: 'power' });
  });
});

// ===========================================================================
// ADR-0051 §1 — shelves, surfaces, the sketch.

/** A bare Device/Chassis pair, `HasChassis`'d together, with no placement
 * and no catalogue model — the shape a fresh sketch chassis, or an item
 * `placeOnShelf`/`fixTo` places for the first time, needs and no existing
 * command builds on its own (`placeChassis` always mounts in a rack). */
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

function barePassiveNode(doc: Document, form: string): { doc: Document; id: string } {
  const id = formatNodeId('PassiveNode', newUlid(NOW));
  const next: Document = {
    ...doc,
    nodes: [...doc.nodes, { id, existence: newUlid(NOW), fields: { 'PassiveNode.form': { presence: 'set', prov: newUlid(NOW), value: form } } }],
  };
  return { doc: next, id };
}

describe('placeChassis writes PhysicalPort.face and pairs a panel/outlet by PassThrough (ADR-0051 §1)', () => {
  it('writes face on every ordinary port and every PSU inlet', () => {
    const { doc, rackId } = rackOf(42);
    const next = placeChassis(doc, rackId, MODEL_1U, 12, 'front', { now: NOW });
    const chassisId = edgesIn(next, rackId, 'MountedIn')[0].from;
    for (const e of edgesOut(next, chassisId, 'HasPort')) {
      const face = readPhysicalPortFields(findNode(next, e.to)!).face;
      expect(face === 'front' || face === 'rear').toBe(true);
    }
    for (const f of edgesOut(next, chassisId, 'FittedIn')) {
      const inletEdge = edgesOut(next, f.to, 'HasPort')[0];
      // MODEL_1U's PSU slots both declare `face: 'rear'`.
      expect(readPhysicalPortFields(findNode(next, inletEdge.to)!).face).toBe('rear');
    }
  });

  it('pairs front port i with rear port i by index when the catalogue form is outlet or panel', () => {
    const { doc, rackId } = rackOf(42);
    const panelModel = { ...MODEL_1U, psuSlots: [], form: 'panel' } as CatalogueModel & { form: string };
    const next = placeChassis(doc, rackId, panelModel, 12, 'front', { now: NOW });
    const chassisId = edgesIn(next, rackId, 'MountedIn')[0].from;
    const portIds = new Set(edgesOut(next, chassisId, 'HasPort').map((e) => e.to));
    const passThroughs = next.edges.filter((e) => e.id.startsWith('pass-through:'));
    // MODEL_1U: two front ports, one rear port — exactly one pair.
    expect(passThroughs).toHaveLength(1);
    expect(portIds.has(passThroughs[0].from)).toBe(true);
    expect(portIds.has(passThroughs[0].to)).toBe(true);
  });

  it('does not pair ports for an ordinary catalogue form', () => {
    const { doc, rackId } = rackOf(42);
    const next = placeChassis(doc, rackId, MODEL_1U, 12, 'front', { now: NOW });
    expect(next.edges.filter((e) => e.id.startsWith('pass-through:'))).toHaveLength(0);
  });
});

describe('createShelf', () => {
  it('creates a PassiveNode form shelf, MountedIn the rack, heightU from the model', () => {
    const { doc, rackId } = rackOf(42);
    const shelfModel: CatalogueModel = { ...MODEL_1U, rackUnits: 2 };
    const next = createShelf(doc, rackId, { label: 'Shelf', positionU: 10, model: shelfModel, now: NOW });
    const mounted = edgesIn(next, rackId, 'MountedIn')[0];
    expect(readMountedInFields(mounted)).toEqual({ positionU: 10, heightU: 2, face: 'front' });
    const shelf = findNode(next, mounted.from)!;
    expect(readPassiveNodeFields(shelf).form).toBe('shelf');
    expect(readPassiveNodeFields(shelf).model).toBe(shelfModel.model);
  });

  // This session's brief item 1 — `PassiveNode.label` is schema card "1"
  // (required); `createShelf` writes it from `opts.label` rather than
  // leaving it absent, so the shelf's plate and editor have a name to show
  // instead of falling back to the node id.
  it('writes PassiveNode.label from opts.label', () => {
    const { doc, rackId } = rackOf(42);
    const next = createShelf(doc, rackId, { label: 'Mini PC shelf', positionU: 10, now: NOW });
    const shelfId = edgesIn(next, rackId, 'MountedIn')[0].from;
    expect(readPassiveNodeFields(findNode(next, shelfId)!).label).toBe('Mini PC shelf');
  });

  it('defaults heightU to 1 with no model', () => {
    const { doc, rackId } = rackOf(42);
    const next = createShelf(doc, rackId, { label: 'Shelf', positionU: 10, now: NOW });
    expect(edgesIn(next, rackId, 'MountedIn')[0].fields['MountedIn.height_u']).toMatchObject({ value: 1 });
  });

  it('refuses an overlap the way placeChassis does', () => {
    const { doc, rackId } = rackOf(42);
    const once = createShelf(doc, rackId, { label: 'Shelf', positionU: 10, now: NOW });
    expect(() => createShelf(once, rackId, { label: 'Shelf', positionU: 10, now: NOW })).toThrow(RackOverlapError);
  });

  it('refuses an out-of-range unit', () => {
    const { doc, rackId } = rackOf(10);
    expect(() => createShelf(doc, rackId, { label: 'Shelf', positionU: 11, now: NOW })).toThrow(RackRangeError);
  });
});

function shelfOf(heightU = 42): { doc: Document; rackId: string; shelfId: string } {
  const { doc, rackId } = rackOf(heightU);
  const withShelf = createShelf(doc, rackId, { label: 'Shelf', positionU: 10, now: NOW });
  const shelfId = edgesIn(withShelf, rackId, 'MountedIn')[0].from;
  return { doc: withShelf, rackId, shelfId };
}

describe('placeOnShelf', () => {
  it('writes SitsOn with slot', () => {
    const { doc, shelfId } = shelfOf();
    const { doc: withItem, chassisId } = bareChassis(doc);
    const next = placeOnShelf(withItem, chassisId, shelfId, 1, { now: NOW });
    const sitsOn = edgesOut(next, chassisId, 'SitsOn')[0];
    expect(sitsOn.to).toBe(shelfId);
    expect(readSitsOnFields(sitsOn)).toEqual({ slot: 1 });
  });

  it('refuses a target that is not a shelf', () => {
    const { doc, rackId } = rackOf(42);
    const { doc: withItem, chassisId } = bareChassis(doc);
    expect(() => placeOnShelf(withItem, chassisId, rackId, 1, { now: NOW })).toThrow(NotAShelfError);
  });

  it('refuses a taken slot', () => {
    const { doc, shelfId } = shelfOf();
    const { doc: withItem1, chassisId: item1 } = bareChassis(doc);
    const once = placeOnShelf(withItem1, item1, shelfId, 1, { now: NOW });
    const { doc: withItem2, chassisId: item2 } = bareChassis(once);
    expect(() => placeOnShelf(withItem2, item2, shelfId, 1, { now: NOW })).toThrow(SlotTakenError);
  });

  it('refuses an item already placed elsewhere', () => {
    const { doc, rackId } = rackOf(42);
    const withShelf = createShelf(doc, rackId, { label: 'Shelf', positionU: 10, now: NOW });
    const shelfId = edgesIn(withShelf, rackId, 'MountedIn')[0].from;
    const placed = placeChassis(withShelf, rackId, MODEL_1U, 20, 'front', { now: NOW });
    const chassisId = edgesIn(placed, rackId, 'MountedIn').find((e) => e.from !== shelfId)!.from;
    expect(() => placeOnShelf(placed, chassisId, shelfId, 1, { now: NOW })).toThrow(AlreadyPlacedError);
  });
});

describe('createSurface', () => {
  it('creates a Surface HasSurface the premises', () => {
    const { doc, premisesId } = docWithPremises();
    const next = createSurface(doc, premisesId, { label: 'North wall', form: 'wall', now: NOW });
    const hasSurface = edgesOut(next, premisesId, 'HasSurface')[0];
    const surface = findNode(next, hasSurface.to)!;
    expect(readSurfaceFields(surface)).toEqual({ label: 'North wall', form: 'wall', widthMm: undefined, heightMm: undefined });
  });

  it('writes optional widthMm/heightMm', () => {
    const { doc, premisesId } = docWithPremises();
    const next = createSurface(doc, premisesId, { label: 'Desk 4', form: 'desk', widthMm: 1200, heightMm: 750, now: NOW });
    const surface = findNode(next, edgesOut(next, premisesId, 'HasSurface')[0].to)!;
    expect(readSurfaceFields(surface)).toMatchObject({ widthMm: 1200, heightMm: 750 });
  });

  it('refuses an unknown premises', () => {
    const { doc } = docWithPremises();
    expect(() =>
      createSurface(doc, 'premises:01ARZ3NDEKTSV4RRFFQ69G5FAV', { label: 'X', form: 'wall', now: NOW }),
    ).toThrow(UnknownReferenceError);
  });

  it('refuses a form outside the schema enum', () => {
    const { doc, premisesId } = docWithPremises();
    // @ts-expect-error -- deliberately outside SurfaceForm to exercise the runtime refusal
    expect(() => createSurface(doc, premisesId, { label: 'X', form: 'ceiling-ish', now: NOW })).toThrow(FieldValueError);
  });
});

describe('fixTo', () => {
  it('fixes an item to a Surface with optional xMm/yMm', () => {
    const { doc, premisesId } = docWithPremises();
    const withSurface = createSurface(doc, premisesId, { label: 'North wall', form: 'wall', now: NOW });
    const surfaceId = edgesOut(withSurface, premisesId, 'HasSurface')[0].to;
    const { doc: withItem, chassisId } = bareChassis(withSurface);
    const next = fixTo(withItem, chassisId, surfaceId, { xMm: 500, yMm: 1200 }, { now: NOW });
    const fixed = edgesOut(next, chassisId, 'FixedTo')[0];
    expect(fixed.to).toBe(surfaceId);
    expect(readFixedToFields(fixed)).toEqual({ xMm: 500, yMm: 1200 });
  });

  it('fixes an item to a PassiveNode of form board', () => {
    const { doc, premisesId } = docWithPremises();
    const withSurface = createSurface(doc, premisesId, { label: 'North wall', form: 'wall', now: NOW });
    const surfaceId = edgesOut(withSurface, premisesId, 'HasSurface')[0].to;
    const { doc: withBoard, id: boardId } = barePassiveNode(withSurface, 'board');
    const boardFixed = fixTo(withBoard, boardId, surfaceId, {}, { now: NOW });
    const { doc: withOutlet, chassisId } = bareChassis(boardFixed);
    const next = fixTo(withOutlet, chassisId, boardId, { xMm: 10 }, { now: NOW });
    expect(edgesOut(next, chassisId, 'FixedTo')[0].to).toBe(boardId);
  });

  it('refuses a target that is neither a Surface nor a board', () => {
    const { doc, rackId } = rackOf(42);
    const { doc: withItem, chassisId } = bareChassis(doc);
    expect(() => fixTo(withItem, chassisId, rackId, {}, { now: NOW })).toThrow(InvalidFixedToTargetError);
  });

  it('refuses a PassiveNode target whose form is not board', () => {
    const { doc } = docWithPremises();
    const { doc: withOther, id: notBoardId } = barePassiveNode(doc, 'splitter');
    const { doc: withItem, chassisId } = bareChassis(withOther);
    expect(() => fixTo(withItem, chassisId, notBoardId, {}, { now: NOW })).toThrow(InvalidFixedToTargetError);
  });

  it('refuses an item already placed elsewhere', () => {
    const { doc, premisesId, rackId } = rackOf(42);
    const placed = placeChassis(doc, rackId, MODEL_1U, 12, 'front', { now: NOW });
    const chassisId = edgesIn(placed, rackId, 'MountedIn')[0].from;
    const withSurface = createSurface(placed, premisesId, { label: 'North wall', form: 'wall', now: NOW });
    const surfaceId = edgesOut(withSurface, premisesId, 'HasSurface')[0].to;
    expect(() => fixTo(withSurface, chassisId, surfaceId, {}, { now: NOW })).toThrow(AlreadyPlacedError);
  });
});

// This session's brief item 2 — "a box with no catalogue entry": the
// palette's own two new rows, `racks/palette.ts`.
describe('createSketchDevice', () => {
  it('creates a Device and a Chassis, HasChassis between them, no Chassis.model', () => {
    const { doc } = docWithPremises();
    const beforeIds = new Set(doc.nodes.map((n) => n.id));
    const next = createSketchDevice(doc, { now: NOW });
    const added = next.nodes.filter((n) => !beforeIds.has(n.id));
    expect(added).toHaveLength(2);
    const chassis = added.find((n) => n.id.startsWith('chassis:'))!;
    const device = added.find((n) => n.id.startsWith('device:'))!;
    expect(readChassisFields(chassis).model).toBeUndefined();
    const hasChassis = edgesOut(next, device.id, 'HasChassis')[0];
    expect(hasChassis.to).toBe(chassis.id);
  });

  it('leaves Device.hostname unset when none is given', () => {
    const { doc } = docWithPremises();
    const beforeIds = new Set(doc.nodes.map((n) => n.id));
    const next = createSketchDevice(doc, { now: NOW });
    const device = next.nodes.find((n) => !beforeIds.has(n.id) && n.id.startsWith('device:'))!;
    expect(device.fields['Device.hostname']).toBeUndefined();
  });

  it('writes Device.hostname when given', () => {
    const { doc } = docWithPremises();
    const beforeIds = new Set(doc.nodes.map((n) => n.id));
    const next = createSketchDevice(doc, { hostname: 'sketch-01', now: NOW });
    const device = next.nodes.find((n) => !beforeIds.has(n.id) && n.id.startsWith('device:'))!;
    expect(device.fields['Device.hostname']).toMatchObject({ presence: 'set', value: 'sketch-01' });
  });

  it('refuses a malformed hostname the same way document/model.ts\'s identifier() does', () => {
    const { doc } = docWithPremises();
    expect(() => createSketchDevice(doc, { hostname: '', now: NOW })).toThrow(RangeError);
  });

  it('creates a device unplaced — no MountedIn/SitsOn/FixedTo written', () => {
    const { doc } = docWithPremises();
    const beforeIds = new Set(doc.nodes.map((n) => n.id));
    const next = createSketchDevice(doc, { now: NOW });
    const chassis = next.nodes.find((n) => !beforeIds.has(n.id) && n.id.startsWith('chassis:'))!;
    expect(edgesOut(next, chassis.id, 'MountedIn')).toHaveLength(0);
    expect(edgesOut(next, chassis.id, 'SitsOn')).toHaveLength(0);
    expect(edgesOut(next, chassis.id, 'FixedTo')).toHaveLength(0);
  });
});

// This session's brief item 2 — "a board".
describe('createBoard', () => {
  it('creates a PassiveNode form board, FixedTo the surface, with optional xMm/yMm', () => {
    const { doc, premisesId } = docWithPremises();
    const withSurface = createSurface(doc, premisesId, { label: 'North wall', form: 'wall', now: NOW });
    const surfaceId = edgesOut(withSurface, premisesId, 'HasSurface')[0].to;
    const next = createBoard(withSurface, surfaceId, { label: 'Backboard', xMm: 100, yMm: 900, now: NOW });
    const beforeIds = new Set(withSurface.nodes.map((n) => n.id));
    const board = next.nodes.find((n) => !beforeIds.has(n.id))!;
    expect(readPassiveNodeFields(board)).toMatchObject({ form: 'board', label: 'Backboard' });
    const fixed = edgesOut(next, board.id, 'FixedTo')[0];
    expect(fixed.to).toBe(surfaceId);
    expect(readFixedToFields(fixed)).toEqual({ xMm: 100, yMm: 900 });
  });

  it('xMm/yMm are both optional', () => {
    const { doc, premisesId } = docWithPremises();
    const withSurface = createSurface(doc, premisesId, { label: 'North wall', form: 'wall', now: NOW });
    const surfaceId = edgesOut(withSurface, premisesId, 'HasSurface')[0].to;
    const next = createBoard(withSurface, surfaceId, { label: 'Backboard', now: NOW });
    const fixed = edgesIn(next, surfaceId, 'FixedTo')[0];
    expect(readFixedToFields(fixed)).toEqual({});
  });

  it('refuses an unknown surface', () => {
    const { doc } = docWithPremises();
    expect(() => createBoard(doc, 'surface:01ARZ3NDEKTSV4RRFFQ69G5FAV', { label: 'X', now: NOW })).toThrow(
      UnknownReferenceError,
    );
  });

  it('refuses a target that is neither a Surface nor a board', () => {
    const { doc, rackId } = rackOf(42);
    expect(() => createBoard(doc, rackId, { label: 'X', now: NOW })).toThrow(InvalidFixedToTargetError);
  });

  it('creates a board fixed to another board', () => {
    const { doc, premisesId } = docWithPremises();
    const withSurface = createSurface(doc, premisesId, { label: 'North wall', form: 'wall', now: NOW });
    const surfaceId = edgesOut(withSurface, premisesId, 'HasSurface')[0].to;
    const withBoard = createBoard(withSurface, surfaceId, { label: 'Backboard', now: NOW });
    const boardId = edgesIn(withBoard, surfaceId, 'FixedTo')[0].from;
    const next = createBoard(withBoard, boardId, { label: 'Sub-board', now: NOW });
    const subBoard = edgesIn(next, boardId, 'FixedTo')[0].from;
    expect(readPassiveNodeFields(findNode(next, subBoard)!).form).toBe('board');
  });
});

describe('movePlacement', () => {
  it('moves a rack-mounted chassis to a shelf: MountedIn tombstoned, SitsOn written', () => {
    const { doc, rackId } = rackOf(42);
    const withShelf = createShelf(doc, rackId, { label: 'Shelf', positionU: 10, now: NOW });
    const shelfId = edgesIn(withShelf, rackId, 'MountedIn')[0].from;
    const placed = placeChassis(withShelf, rackId, MODEL_1U, 20, 'front', { now: NOW });
    const chassisId = edgesIn(placed, rackId, 'MountedIn').find((e) => e.from !== shelfId)!.from;

    const moved = movePlacement(placed, chassisId, { kind: 'shelf', shelfId, slot: 1 }, { now: NOW });
    expect(edgesOut(moved, chassisId, 'MountedIn')).toHaveLength(0);
    const sitsOn = edgesOut(moved, chassisId, 'SitsOn')[0];
    expect(sitsOn.to).toBe(shelfId);
    expect(readSitsOnFields(sitsOn)).toEqual({ slot: 1 });
  });

  it('moves a shelved item to a rack, defaulting to 1U with no prior MountedIn', () => {
    const { doc, rackId } = rackOf(42);
    const withShelf = createShelf(doc, rackId, { label: 'Shelf', positionU: 10, now: NOW });
    const shelfId = edgesIn(withShelf, rackId, 'MountedIn')[0].from;
    const { doc: withItem, chassisId } = bareChassis(withShelf);
    const onShelf = placeOnShelf(withItem, chassisId, shelfId, 1, { now: NOW });

    const moved = movePlacement(onShelf, chassisId, { kind: 'rack', rackId, positionU: 30, face: 'front' }, { now: NOW });
    expect(edgesOut(moved, chassisId, 'SitsOn')).toHaveLength(0);
    const mounted = edgesOut(moved, chassisId, 'MountedIn')[0];
    expect(readMountedInFields(mounted)).toEqual({ positionU: 30, heightU: 1, face: 'front' });
  });

  it('carries forward the prior MountedIn.height_u on a rack-to-rack move', () => {
    const { doc, premisesId, rackId } = rackOf(42);
    const model2U: CatalogueModel = { ...MODEL_1U, rackUnits: 2 };
    const placed = placeChassis(doc, rackId, model2U, 12, 'front', { now: NOW });
    const chassisId = edgesIn(placed, rackId, 'MountedIn')[0].from;
    const withTarget = createRack(placed, premisesId, { label: 'R2', heightU: 42, unitNumbering: 'ascending', now: NOW });
    const targetRackId = edgesOut(withTarget, premisesId, 'HasRack').find((e) => e.to !== rackId)!.to;

    const moved = movePlacement(withTarget, chassisId, { kind: 'rack', rackId: targetRackId, positionU: 5, face: 'rear' }, { now: NOW });
    const mounted = edgesOut(moved, chassisId, 'MountedIn')[0];
    expect(readMountedInFields(mounted)).toEqual({ positionU: 5, heightU: 2, face: 'rear' });
  });

  it('moves an item to a surface: FixedTo written, unmeasured means absent, not zero', () => {
    const { doc, premisesId, rackId } = rackOf(42);
    const placed = placeChassis(doc, rackId, MODEL_1U, 12, 'front', { now: NOW });
    const chassisId = edgesIn(placed, rackId, 'MountedIn')[0].from;
    const withSurface = createSurface(placed, premisesId, { label: 'Floor', form: 'floor', now: NOW });
    const surfaceId = edgesOut(withSurface, premisesId, 'HasSurface')[0].to;

    const moved = movePlacement(withSurface, chassisId, { kind: 'surface', surfaceId, xMm: null, yMm: null }, { now: NOW });
    expect(edgesOut(moved, chassisId, 'MountedIn')).toHaveLength(0);
    const fixed = edgesOut(moved, chassisId, 'FixedTo')[0];
    expect(fixed.to).toBe(surfaceId);
    expect(readFixedToFields(fixed)).toEqual({ xMm: undefined, yMm: undefined });
  });

  it('moves an item to none: the prior placement is tombstoned, nothing new written', () => {
    const { doc, rackId } = rackOf(42);
    const placed = placeChassis(doc, rackId, MODEL_1U, 12, 'front', { now: NOW });
    const chassisId = edgesIn(placed, rackId, 'MountedIn')[0].from;

    const moved = movePlacement(placed, chassisId, { kind: 'none' }, { now: NOW });
    expect(edgesOut(moved, chassisId, 'MountedIn')).toHaveLength(0);
    expect(edgesOut(moved, chassisId, 'SitsOn')).toHaveLength(0);
    expect(edgesOut(moved, chassisId, 'FixedTo')).toHaveLength(0);
  });

  it('refuses an overlap on a rack move, exactly as placeChassis does', () => {
    const { doc, rackId } = rackOf(42);
    let working = placeChassis(doc, rackId, MODEL_1U, 12, 'front', { now: NOW });
    working = placeChassis(working, rackId, MODEL_1U, 13, 'front', { now: NOW });
    const first = edgesIn(working, rackId, 'MountedIn').find((e) => readMountedInFields(e).positionU === 12)!;
    expect(() =>
      movePlacement(working, first.from, { kind: 'rack', rackId, positionU: 13, face: 'front' }, { now: NOW }),
    ).toThrow(RackOverlapError);
  });

  it('refuses a shelf move onto a taken slot', () => {
    const { doc, rackId } = rackOf(42);
    const withShelf = createShelf(doc, rackId, { label: 'Shelf', positionU: 10, now: NOW });
    const shelfId = edgesIn(withShelf, rackId, 'MountedIn')[0].from;
    const { doc: withItem1, chassisId: item1 } = bareChassis(withShelf);
    const once = placeOnShelf(withItem1, item1, shelfId, 1, { now: NOW });
    const { doc: withItem2, chassisId: item2 } = bareChassis(once);
    const onShelf2 = placeOnShelf(withItem2, item2, shelfId, 2, { now: NOW });
    expect(() => movePlacement(onShelf2, item2, { kind: 'shelf', shelfId, slot: 1 }, { now: NOW })).toThrow(SlotTakenError);
  });
});

describe('addSketchPort / removeSketchPort', () => {
  it('adds a port typed by hand', () => {
    const { doc, chassisId } = bareChassis(emptyDocument());
    const next = addSketchPort(doc, chassisId, { label: 'eth0', connector: 'rj45', face: 'front' }, { now: NOW });
    const ports = edgesOut(next, chassisId, 'HasPort');
    expect(ports).toHaveLength(1);
    expect(readPhysicalPortFields(findNode(next, ports[0].to)!)).toEqual({
      label: 'eth0',
      connector: 'rj45',
      face: 'front',
      service: undefined,
    });
  });

  it('writes an optional service field', () => {
    const { doc, chassisId } = bareChassis(emptyDocument());
    const next = addSketchPort(doc, chassisId, { label: 'inlet', connector: 'c14', service: 'power', face: 'rear' }, { now: NOW });
    const port = findNode(next, edgesOut(next, chassisId, 'HasPort')[0].to)!;
    expect(readPhysicalPortFields(port).service).toBe('power');
  });

  it('refuses an unknown connector', () => {
    const { doc, chassisId } = bareChassis(emptyDocument());
    expect(() => addSketchPort(doc, chassisId, { label: 'eth0', connector: 'mystery', face: 'front' }, { now: NOW })).toThrow(
      FieldValueError,
    );
  });

  it('refuses an unknown service', () => {
    const { doc, chassisId } = bareChassis(emptyDocument());
    expect(() =>
      addSketchPort(doc, chassisId, { label: 'eth0', connector: 'rj45', service: 'mystery', face: 'front' }, { now: NOW }),
    ).toThrow(FieldValueError);
  });

  it('refuses a chassis that already has a catalogue model', () => {
    const { doc, rackId } = rackOf(42);
    const placed = placeChassis(doc, rackId, MODEL_1U, 12, 'front', { now: NOW });
    const chassisId = edgesIn(placed, rackId, 'MountedIn')[0].from;
    expect(() =>
      addSketchPort(placed, chassisId, { label: 'eth9', connector: 'rj45', face: 'front' }, { now: NOW }),
    ).toThrow(SketchOnCatalogueChassisError);
  });

  it('removeSketchPort tombstones the port and its HasPort edge', () => {
    const { doc, chassisId } = bareChassis(emptyDocument());
    const withPort = addSketchPort(doc, chassisId, { label: 'eth0', connector: 'rj45', face: 'front' }, { now: NOW });
    const portId = edgesOut(withPort, chassisId, 'HasPort')[0].to;
    const removed = removeSketchPort(withPort, chassisId, portId, { now: NOW });
    expect(findNode(removed, portId)!.absentSince).toBe(NOW);
    expect(edgesOut(removed, chassisId, 'HasPort')).toHaveLength(0);
  });

  it('removeSketchPort refuses a port not on this chassis', () => {
    const { doc, chassisId } = bareChassis(emptyDocument());
    expect(() =>
      removeSketchPort(doc, chassisId, 'physical-port:01ARZ3NDEKTSV4RRFFQ69G5FAV', { now: NOW }),
    ).toThrow(UnknownReferenceError);
  });
});

// ADR-0053 §2 — a replaced field is archived into `doc.history`, the way
// `fathom-graph::Graph::archive_replaced` does, so a prior value exists.
describe('setField archives the replaced value into doc.history', () => {
  it('moveChassis (same rack) archives the old position_u and face', () => {
    const { doc, rackId } = rackOf(42);
    const placed = placeChassis(doc, rackId, MODEL_1U, 12, 'front', { now: NOW });
    const mounted = edgesIn(placed, rackId, 'MountedIn')[0];
    const chassisId = mounted.from;
    const oldPositionProv = mounted.fields['MountedIn.position_u'].prov;
    const oldFaceProv = mounted.fields['MountedIn.face'].prov;

    const moved = moveChassis(placed, chassisId, rackId, 20, 'rear', { now: NOW + 1 });
    const movedEdge = edgesIn(moved, rackId, 'MountedIn')[0];

    const positionHistory = moved.history.find(
      (h) => h.element === movedEdge.id && h.field === 'MountedIn.position_u',
    )!;
    expect(positionHistory.entries).toEqual([{ presence: 'set', prov: oldPositionProv, value: 12 }]);
    expect(positionHistory.truncated).toBe(0);

    const faceHistory = moved.history.find((h) => h.element === movedEdge.id && h.field === 'MountedIn.face')!;
    expect(faceHistory.entries).toEqual([{ presence: 'set', prov: oldFaceProv, value: 'front' }]);

    // The new field entry supersedes the archived one.
    const newProv = moved.provenance.find((p) => p.id === movedEdge.fields['MountedIn.position_u'].prov)!;
    expect(newProv.supersedes).toBe(oldPositionProv);
  });

  it('a field set for the first time archives nothing (no prior slot)', () => {
    const { doc, chassisId } = bareChassis(emptyDocument());
    const next = addSketchPort(doc, chassisId, { label: 'eth0', connector: 'rj45', face: 'front' }, { now: NOW });
    const portId = edgesOut(next, chassisId, 'HasPort')[0].to;
    expect(next.history.find((h) => h.element === portId)).toBeUndefined();
  });
});
