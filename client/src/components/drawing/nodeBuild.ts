/** Builds one chassis node through its caches, apart from React so a test
 * can call it directly. */

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

/** One chassis's node: `chassis` keeps its old reference when no field changed,
 * so an edit elsewhere leaves this node as it was. `portSheath` comes stable. */
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
      // Sizes known up front, so React Flow never hides this node while it
      // waits to measure it, even when its reference changes.
      width: widthPx,
      height: heightPx,
      style: { width: widthPx, height: heightPx },
      data: { chassis: stableChassis, ports, inlets, elevation, onSelectPort, portSheath } satisfies ChassisNodeData,
    }),
  ) as ChassisNodeType;
}
