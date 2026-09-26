/**
 * GitHub issue #66: the one piece of `Drawing.tsx`'s own node-building loop
 * pulled out where a test can call it directly, without rendering React at
 * all — `Drawing.tsx` calls this exact function for every chassis it draws
 * (`ChassisNode`, the "2,100 devices" the brief measures against); a
 * vitest that imported `Drawing.tsx` itself and drove it through
 * `renderToStaticMarkup` could not exercise a SECOND render with the SAME
 * caches at all (SSR runs a component once, no `useEffect`, no re-render),
 * which is exactly what "kept its reference across a hover/selection/zoom/
 * drag render" needs to prove. This needs no React renderer to call:
 * `IdCache`/`RefSignatureCache` are the caller's own, held across calls the
 * same way `Drawing.tsx` holds them in a `useRef`.
 */

import type { Node } from '@xyflow/react';

import type { ChassisView, InletView, PortView, Sheath } from './contract';
import type { ChassisNodeData, ChassisNodeType } from './ChassisNode';
import type { Facing } from './elevation';
import { IdCache, RefSignatureCache } from './idCache';
import { chassisNodeId } from './nodeId';

export interface ChassisNodeCaches {
  // `Node`, not `ChassisNodeType` — `Drawing.tsx` keeps ONE `IdCache` shared
  // by every node type it draws (one `sweep()`, one place a removed rack,
  // chassis, shelf, surface or tray's stale entry is dropped), and this is
  // that same cache passed in, not a second one only this function owns.
  nodeCache: IdCache<Node>;
  chassisSig: RefSignatureCache;
}

export function createChassisNodeCaches(): ChassisNodeCaches {
  return { nodeCache: new IdCache<Node>(), chassisSig: new RefSignatureCache() };
}

/** One chassis's own React Flow node — `Drawing.tsx`'s own node-building
 * loop calls this once per `FaceplateItem` it walks. `chassis`'s own
 * fingerprint (`RefSignatureCache`, never a look past this one device) plus
 * `elevation`/`portSheath`/position/`canDraw`/`onSelectPort` are this node's
 * whole dependency list — nothing hover, selection, zoom or drag touches is
 * in it (`liveStore.ts` carries all of that instead), so the SAME `Node`
 * object comes back on any render where none of those actually changed. */
export function buildChassisNode(
  chassis: ChassisView,
  ports: PortView[],
  inlets: InletView[],
  elevation: Facing,
  position: { x: number; y: number },
  canDraw: boolean,
  portSheath: ReadonlyMap<string, Sheath>,
  // `portSheath` itself is a `Map`, rebuilt with a fresh reference on ANY
  // document edit (`view.cables` is rebuilt fresh by `viewOf`, even one that
  // touched no cable at all) — a caller's own content signature of it
  // (`Drawing.tsx`'s `portSheathSig`, one `RefSignatureCache` shared by
  // every chassis/shelf/surface rather than one each), so an edit
  // elsewhere never invalidates a device whose own sheaths did not change.
  portSheathSig: string,
  onSelectPort: (portId: string) => void,
  widthPx: number,
  heightPx: number,
  caches: ChassisNodeCaches,
): ChassisNodeType {
  const id = chassisNodeId(chassis.id);
  const chassisSig = caches.chassisSig.of(chassis.id, chassis);
  return caches.nodeCache.get(
    id,
    [chassisSig, elevation, portSheathSig, position.x, position.y, canDraw, onSelectPort],
    () => ({
      id,
      type: 'chassis',
      position,
      draggable: canDraw,
      selectable: true,
      zIndex: 10,
      style: { width: widthPx, height: heightPx },
      data: { chassis, ports, inlets, elevation, onSelectPort, portSheath } satisfies ChassisNodeData,
    }),
  ) as ChassisNodeType;
}
