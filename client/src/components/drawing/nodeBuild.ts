/** `Drawing.tsx` calls this once per chassis it draws — pulled out here so a
 * test can call it directly, across more than one call with the same
 * caches, without rendering React at all. */

import type { Node } from '@xyflow/react';

import type { ChassisView, InletView, PortView, Sheath } from './contract';
import type { ChassisNodeData, ChassisNodeType } from './ChassisNode';
import type { Facing } from './elevation';
import { IdCache, StableRef } from './idCache';
import { chassisEqual } from './nodeEquality';
import { chassisNodeId } from './nodeId';

export interface ChassisNodeCaches {
  // Shared with every other node kind `Drawing.tsx` draws, one `sweep()`.
  nodeCache: IdCache<Node>;
  chassisRef: StableRef<ChassisView>;
}

export function createChassisNodeCaches(): ChassisNodeCaches {
  return { nodeCache: new IdCache<Node>(), chassisRef: new StableRef<ChassisView>() };
}

/** One chassis's own React Flow node. `chassis` is stabilised first (the
 * same reference as last time when nothing about it changed field by
 * field) so the node cache below sees no change across an edit elsewhere.
 * `portSheath` is expected already stabilised by the caller. */
export function buildChassisNode(
  chassis: ChassisView,
  ports: PortView[],
  inlets: InletView[],
  elevation: Facing,
  position: { x: number; y: number },
  canDraw: boolean,
  portSheath: ReadonlyMap<string, Sheath>,
  onSelectPort: (portId: string) => void,
  widthPx: number,
  heightPx: number,
  caches: ChassisNodeCaches,
): ChassisNodeType {
  const id = chassisNodeId(chassis.id);
  const stableChassis = caches.chassisRef.get(chassis.id, chassis, chassisEqual);
  return caches.nodeCache.get(
    id,
    [stableChassis, elevation, portSheath, position.x, position.y, canDraw, onSelectPort],
    () => ({
      id,
      type: 'chassis',
      position,
      draggable: canDraw,
      selectable: true,
      zIndex: 10,
      // React Flow's own `width`/`height` fields, not only `style` below —
      // every size here is known up front, so this node never needs a
      // `ResizeObserver` measurement (and the `visibility: hidden` React
      // Flow shows until one lands) even on a render that gives it a fresh
      // reference, such as its own drag.
      width: widthPx,
      height: heightPx,
      style: { width: widthPx, height: heightPx },
      data: { chassis: stableChassis, ports, inlets, elevation, onSelectPort, portSheath } satisfies ChassisNodeData,
    }),
  ) as ChassisNodeType;
}
