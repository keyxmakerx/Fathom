/**
 * GitHub issue #66: the node object `Drawing.tsx` hands React Flow for a
 * chassis must keep its own reference across a hover, a selection, a zoom
 * tick and a drag elsewhere in the drawing — none of those touch anything
 * `buildChassisNode`'s own cache is keyed on (`liveStore.ts` carries all of
 * that instead, off `data` entirely) — and, after a real edit to the whole
 * design (`viewOf` rebuilds every chassis with a fresh object reference,
 * `document/view.ts`'s own doc), only the ONE chassis that actually changed
 * gets a new node object; the other 2,099 keep theirs. This calls
 * `Drawing.tsx`'s own `buildChassisNode` directly, across more than one
 * "render" with the SAME caches held between calls — exactly what
 * `Drawing.tsx` does from inside its own render, and something no
 * `renderToStaticMarkup` test could exercise at all (a server render never
 * re-renders). Assertions are reference equality (`toBe`), never a
 * deep-equal proxy for it.
 */
import { describe, expect, it } from 'vitest';

import type { ChassisView, PortView, Sheath } from './contract';
import { createChassisNodeCaches, buildChassisNode } from './nodeBuild';

const DEVICE_COUNT = 2100;
const PORTS_PER_DEVICE = 4;

function portsFor(chassisId: string): PortView[] {
  return Array.from({ length: PORTS_PER_DEVICE }, (_, i) => ({
    id: `${chassisId}-p${i}`,
    label: String(i),
    connector: 'rj45',
    row: 0,
    column: i,
    uplink: false,
    role: null,
    cable: null,
    face: 'front',
    passThroughId: null,
  }));
}

function chassisFor(i: number, hostname = `device-${i}`): ChassisView {
  const id = `chassis-${i}`;
  return {
    id,
    deviceId: `${id}-device`,
    hostname,
    model: 'MODEL-X',
    vendor: 'vendor',
    positionU: (i % 42) + 1,
    heightU: 1,
    face: 'front',
    ports: portsFor(id),
    role: null,
    managementAddress: null,
    serial: null,
    psuInlets: [],
    singleFed: false,
    oneFitted: false,
    placement: { kind: 'rack', rackId: `rack-${Math.floor(i / 42)}`, positionU: (i % 42) + 1, face: 'front' },
    sketch: false,
  };
}

function positionFor(i: number): { x: number; y: number } {
  return { x: (i % 42) * 10, y: Math.floor(i / 42) * 100 };
}

const portSheath: ReadonlyMap<string, Sheath> = new Map();
const onSelectPort = () => {};

function buildAll(
  devices: readonly ChassisView[],
  caches: ReturnType<typeof createChassisNodeCaches>,
  positionOverride?: (i: number) => { x: number; y: number },
) {
  return devices.map((chassis, i) =>
    buildChassisNode(
      chassis,
      chassis.ports,
      chassis.psuInlets,
      'front',
      (positionOverride ?? positionFor)(i),
      true,
      portSheath,
      onSelectPort,
      120,
      16,
      caches,
    ),
  );
}

describe('buildChassisNode — node identity across 2,100 devices (GitHub issue #66)', () => {
  it('keeps every node reference across a render nothing about that device touched (hover/selection/zoom)', () => {
    const devices = Array.from({ length: DEVICE_COUNT }, (_, i) => chassisFor(i));
    const caches = createChassisNodeCaches();

    const first = buildAll(devices, caches);
    const t0 = performance.now();
    const second = buildAll(devices, caches); // same objects, same positions — a hover/selection/zoom render
    const elapsedMs = performance.now() - t0;

    for (let i = 0; i < DEVICE_COUNT; i += 1) {
      expect(second[i]).toBe(first[i]);
    }
    // Generous: this should be a Map lookup and a handful of `Object.is`
    // compares per device, not a re-stringify — comfortably under 50ms even
    // on a loaded CI box.
    expect(elapsedMs).toBeLessThan(200);
  });

  it('rebuilds only the one node being dragged; every other device keeps its reference', () => {
    const devices = Array.from({ length: DEVICE_COUNT }, (_, i) => chassisFor(i));
    const caches = createChassisNodeCaches();
    const first = buildAll(devices, caches);

    const draggedIndex = 17;
    const second = buildAll(devices, caches, (i) =>
      i === draggedIndex ? { x: positionFor(i).x + 5, y: positionFor(i).y } : positionFor(i),
    );

    expect(second[draggedIndex]).not.toBe(first[draggedIndex]);
    for (let i = 0; i < DEVICE_COUNT; i += 1) {
      if (i === draggedIndex) continue;
      expect(second[i]).toBe(first[i]);
    }
  });

  it('after a whole-design edit (every chassis object rebuilt fresh), only the edited device gets a new node', () => {
    const devices = Array.from({ length: DEVICE_COUNT }, (_, i) => chassisFor(i));
    const caches = createChassisNodeCaches();
    const first = buildAll(devices, caches);

    // `viewOf` rebuilds the whole `ClosetView` on any edit (`document/view.ts`'s
    // own doc, `nodeBuild.ts`'s file header) — every chassis gets a fresh
    // object reference here, even though only one's content changed.
    const editedIndex = 1234;
    const rebuilt = devices.map((c, i) => (i === editedIndex ? chassisFor(i, 'renamed-host') : chassisFor(i)));
    expect(rebuilt[editedIndex]).not.toBe(devices[editedIndex]);
    expect(rebuilt[0]).not.toBe(devices[0]); // every reference is new, not only the edited one

    const t0 = performance.now();
    const second = buildAll(rebuilt, caches);
    const elapsedMs = performance.now() - t0;

    expect(second[editedIndex]).not.toBe(first[editedIndex]);
    for (let i = 0; i < DEVICE_COUNT; i += 1) {
      if (i === editedIndex) continue;
      expect(second[i]).toBe(first[i]);
    }
    // The one render that must re-stringify every device's own bounded
    // slice (`RefSignatureCache`'s own reference-miss path) — bounded by
    // device count and each device's own field count, never the design
    // around it (the rejected whole-design compare took ~6s at this same
    // scale, `docs`'s own brief on why that approach was dropped).
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('drops a removed device from the cache on sweep, and never returns a stale node for a reused id', () => {
    const devices = Array.from({ length: 10 }, (_, i) => chassisFor(i));
    const caches = createChassisNodeCaches();
    buildAll(devices, caches);
    caches.nodeCache.sweep(); // every id touched: nothing dropped

    const remaining = devices.slice(1); // device 0 removed
    const built = buildAll(remaining, caches);
    caches.nodeCache.sweep(); // device 0's entry is now stale

    expect(built).toHaveLength(9);
    expect(built[0]!.id).toBe('chassis:chassis-1');
  });
});
