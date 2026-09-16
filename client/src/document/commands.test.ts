import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../api/catalogue';
import {
  RackOverlapError,
  RackRangeError,
  UnknownReferenceError,
  createRack,
  moveChassis,
  placeChassis,
  removeChassis,
} from './commands';
import {
  edgesIn,
  edgesOut,
  emptyDocument,
  findNode,
  formatNodeId,
  readChassisFields,
  readMountedInFields,
  readRackFields,
  type Document,
} from './model';
import { newUlid } from './ulid';

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
  psuInlets: { kind: 'C14', count: 2 },
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
    expect(ports).toHaveLength(3); // 2 front + 1 rear, every faceplate's ports
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
  it('updates position and face', () => {
    const { doc, rackId } = rackOf(42);
    const placed = placeChassis(doc, rackId, MODEL_1U, 12, 'front', { now: NOW });
    const chassisId = edgesIn(placed, rackId, 'MountedIn')[0].from;
    const moved = moveChassis(placed, chassisId, 20, 'rear', { now: NOW });
    const mounted = edgesOut(moved, chassisId, 'MountedIn')[0];
    expect(readMountedInFields(mounted)).toEqual({ positionU: 20, heightU: 1, face: 'rear' });
  });

  it('refuses an overlap with another chassis', () => {
    const { doc, rackId } = rackOf(42);
    let working = placeChassis(doc, rackId, MODEL_1U, 12, 'front', { now: NOW });
    working = placeChassis(working, rackId, MODEL_1U, 13, 'front', { now: NOW });
    const first = edgesIn(working, rackId, 'MountedIn').find((e) => readMountedInFields(e).positionU === 12)!;
    expect(() => moveChassis(working, first.from, 13, 'front', { now: NOW })).toThrow(RackOverlapError);
  });

  it('refuses an unknown chassis', () => {
    const { doc } = rackOf(42);
    expect(() => moveChassis(doc, 'chassis:01ARZ3NDEKTSV4RRFFQ69G5FAV', 1, 'front', { now: NOW })).toThrow(
      UnknownReferenceError,
    );
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
