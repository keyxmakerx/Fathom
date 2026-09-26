/** `Drawing.tsx` has no DOM to render in CI, so this calls `buildDrawingNodes`
 * directly, across more than one call with the same caches. Assertions are reference equality (`toBe`/`not.toBe`). */
import { describe, expect, it } from 'vitest';

import type { ChassisView, PortView } from './contract';
import type { RackView, RowView } from '../../document/view';
import { buildDrawingNodes, createDrawingNodeCaches, type BuildDrawingNodesInput } from './buildDrawingNodes';
import { layoutRow } from './rows';

const RACK_COUNT = 50;
const CHASSIS_PER_RACK = 42;
const DEVICE_COUNT = RACK_COUNT * CHASSIS_PER_RACK; // 2,100

// Shared across every `baseInput` call — a fresh closure or empty `Map`
// each call would invalidate every node's own cache entry for no real reason.
const noop = () => {};
const noopHover = (_id: string | null) => {};
const sharedPortSheath = new Map();

function portsFor(chassisId: string): PortView[] {
  return [
    {
      id: `${chassisId}-p0`,
      label: '0',
      connector: 'rj45',
      row: 0,
      column: 0,
      uplink: false,
      role: null,
      cable: null,
      face: 'front',
      passThroughId: null,
    },
  ];
}

function chassisFor(rackIndex: number, u: number, hostname?: string): ChassisView {
  const id = `chassis-${rackIndex}-${u}`;
  return {
    id,
    deviceId: `${id}-device`,
    hostname: hostname ?? id,
    model: 'MODEL-X',
    vendor: 'vendor',
    positionU: u,
    heightU: 1,
    face: 'front',
    ports: portsFor(id),
    role: null,
    managementAddress: null,
    serial: null,
    psuInlets: [],
    singleFed: false,
    oneFitted: false,
    placement: { kind: 'rack', rackId: `rack-${rackIndex}`, positionU: u, face: 'front' },
    sketch: false,
  };
}

function racksFor(chassisAt: (rackIndex: number, u: number) => ChassisView): RackView[] {
  return Array.from({ length: RACK_COUNT }, (_, r) => ({
    id: `rack-${r}`,
    label: `Rack ${r}`,
    heightU: CHASSIS_PER_RACK,
    unitNumbering: 'top-down',
    chassis: Array.from({ length: CHASSIS_PER_RACK }, (_, u) => chassisAt(r, u + 1)),
    shelves: [],
    freeRuns: [],
    row: null,
    bay: null,
  }));
}

function baseInput(racks: RackView[]): BuildDrawingNodesInput {
  const rowViews: RowView[] = [{ label: null, racks }];
  const rowLayouts = rowViews.map((row) => layoutRow(row, 'front'));
  const rackPositions: Record<string, { x: number; y: number }> = {};
  racks.forEach((rack, i) => {
    rackPositions[rack.id] = { x: i * 300, y: 0 };
  });
  return {
    view: { premisesId: 'p1', racks, cables: [], rows: rowViews, surfaces: [], unplaced: [] },
    rowViews,
    rowLayouts,
    rackPositions,
    cameraStop: 'rack',
    elevationFor: () => 'front',
    canDraw: true,
    portSheath: sharedPortSheath,
    dragOverride: null,
    selectedChassisId: null,
    selected: null,
    handleSelectPort: noop,
    handleSelectFixture: noop,
    onFlipRow: noop,
    onFlipRack: noop,
    onSelectShelf: noop,
    onOpenShelfOccupant: noop,
    onHoverInlet: noopHover,
    surfacesLayout: { panels: [], floor: null },
    portalGroups: [],
  };
}

describe('buildDrawingNodes — node and array identity across 2,100 devices', () => {
  it('hands back the SAME nodes array when nothing about the view, layout or selection changed', () => {
    const racks = racksFor((r, u) => chassisFor(r, u));
    const caches = createDrawingNodeCaches();
    const input = baseInput(racks);

    const first = buildDrawingNodes(input, caches);
    // A select (or a hover, which never reaches this function's own inputs
    // at all — `liveStore.ts` owns it) changes no build input here.
    const second = buildDrawingNodes({ ...input, selected: { kind: 'chassis', id: 'chassis-0-1' } }, caches);
    // A zoom tick that has not crossed a camera stop: `cameraStop` unchanged.
    const third = buildDrawingNodes({ ...input, cameraStop: 'rack' }, caches);

    expect(second.nodes).toBe(first.nodes);
    expect(third.nodes).toBe(first.nodes);
  });

  it('keeps every node object across those same renders', () => {
    const racks = racksFor((r, u) => chassisFor(r, u));
    const caches = createDrawingNodeCaches();
    const input = baseInput(racks);

    const first = buildDrawingNodes(input, caches);
    const second = buildDrawingNodes({ ...input, selected: { kind: 'chassis', id: 'chassis-0-1' } }, caches);

    expect(second.nodes).toHaveLength(first.nodes.length);
    for (let i = 0; i < first.nodes.length; i += 1) expect(second.nodes[i]).toBe(first.nodes[i]);
  });

  it('a drag: only the dragged chassis gets a new node; its rack keeps its own', () => {
    const racks = racksFor((r, u) => chassisFor(r, u));
    const caches = createDrawingNodeCaches();
    const input = baseInput(racks);
    const first = buildDrawingNodes(input, caches);

    const draggedId = 'chassis-3-5';
    const second = buildDrawingNodes(
      { ...input, dragOverride: { id: `chassis:${draggedId}`, position: { x: 999, y: 999 } } },
      caches,
    );

    expect(second.nodes).toHaveLength(first.nodes.length);
    let changed = 0;
    for (let i = 0; i < first.nodes.length; i += 1) {
      if (second.nodes[i] !== first.nodes[i]) {
        changed += 1;
        expect(second.nodes[i]!.id).toBe(`chassis:${draggedId}`);
      }
    }
    expect(changed).toBe(1); // the dragged chassis alone — not its rack
  });

  it('a one-device edit: only that device and its rack get a new node; every other rack and device keep theirs', () => {
    const racks = racksFor((r, u) => chassisFor(r, u));
    const caches = createDrawingNodeCaches();
    const input = baseInput(racks);
    const first = buildDrawingNodes(input, caches);

    // A real edit rebuilds every rack and chassis object fresh, even though only one chassis's own fields actually changed.
    const editedRack = 3;
    const editedU = 5;
    const editedRacks = racksFor((r, u) => (r === editedRack && u === editedU ? chassisFor(r, u, 'renamed-host') : chassisFor(r, u)));
    const secondInput = baseInput(editedRacks);
    const second = buildDrawingNodes(secondInput, caches);

    expect(second.nodes).toHaveLength(first.nodes.length);
    const changedIds = new Set<string>();
    for (let i = 0; i < first.nodes.length; i += 1) {
      if (second.nodes[i] !== first.nodes[i]) changedIds.add(second.nodes[i]!.id);
    }
    expect(changedIds).toEqual(new Set([`chassis:chassis-${editedRack}-${editedU}`, `rack:rack-${editedRack}`]));
  });

  it('runs a whole-view rebuild (a real edit) in well under a second, field-compared, never stringified', () => {
    const racks = racksFor((r, u) => chassisFor(r, u));
    const caches = createDrawingNodeCaches();
    const input = baseInput(racks);
    buildDrawingNodes(input, caches);

    const editedRacks = racksFor((r, u) => (r === 0 && u === 1 ? chassisFor(r, u, 'renamed-host') : chassisFor(r, u)));
    const t0 = performance.now();
    buildDrawingNodes(baseInput(editedRacks), caches);
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs).toBeLessThan(1000);
    expect(DEVICE_COUNT).toBe(2100);
  });

  it('fails to reuse anything when the caller makes fresh caches every call — the bug this function exists to prevent', () => {
    const racks = racksFor((r, u) => chassisFor(r, u));
    const input = baseInput(racks);

    const first = buildDrawingNodes(input, createDrawingNodeCaches());
    const second = buildDrawingNodes(input, createDrawingNodeCaches());

    expect(second.nodes).not.toBe(first.nodes);
    expect(second.nodes[0]).not.toBe(first.nodes[0]);
  });
});
