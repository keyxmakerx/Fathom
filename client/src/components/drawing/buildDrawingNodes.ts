/** Every React Flow node `Drawing.tsx` draws — rack, chassis, shelf, surface,
 * tray — built by one pure function: view, layout and caches in, the nodes array out, no React and no DOM. */

import type { Node } from '@xyflow/react';

import type { Facing } from './elevation';
import type { CameraStop } from './geometry';
import type { ClosetView, Selection, Sheath } from './contract';
import { RACK_HEADER_PX, RACK_INNER_PX, RAIL_PX, U_PX, sortFreeRuns, uToOffsetPx } from './geometry';
import { faceplateItems, type FaceplateItem } from './elevation';
import { IdCache, StableRef } from './idCache';
import {
  faceplateItemsEqual,
  placementEqual,
  portalGroupEqual,
  rackSnapshotEqual,
  shelfEqual,
  type RackSnapshot,
} from './nodeEquality';
import { buildChassisNode, createChassisNodeCaches, type ChassisNodeCaches } from './nodeBuild';
import { chassisNodeId, rackNodeId, rowLabelNodeId, shelfNodeId, surfaceNodeId, trayNodeId } from './nodeId';
import { locatePort } from './lookup';
import { portalCountLabel, type PortalGroup } from './portals';
import { PORTAL_TRAY_HEIGHT, type PortalTrayNodeData } from './PortalTrayNode';
import { RACK_NODE_WIDTH, rackNodeHeight, type RackNodeData } from './RackNode';
import { ROW_LABEL_WIDTH, type RowLabelNodeData } from './RowLabelNode';
import { type ShelfPlateNodeData } from './ShelfPlate';
import { type SurfaceNodeData } from './SurfaceNode';
import { RACK_GAP_PX, ROW_GAP_PX, rowBandY, rowKey, type RowLayout, type SurfacesLayout } from './rows';
import type { RowView } from './contract';
import type { ShelfView } from '../../document/view';

/** Gap between one rack's portal tray(s) and the next, on the same side. */
const TRAY_GAP_PX = 12;

export interface DrawingNodeCaches {
  nodeCache: IdCache<Node>;
  faceplateItemsCache: IdCache<readonly FaceplateItem[]>;
  chassisNodeCaches: ChassisNodeCaches;
  rackSnapshotRef: StableRef<RackSnapshot>;
  itemsRef: StableRef<readonly FaceplateItem[]>;
  shelfRef: StableRef<ShelfView>;
  placementRef: StableRef<import('./rows').SurfacePlacement>;
  portalGroupRef: StableRef<PortalGroup>;
  /** The array handed back last call — reused, same reference, when every
   * element this call built is `===` the element at the same index last time. */
  prevNodes: Node[] | null;
}

export function createDrawingNodeCaches(): DrawingNodeCaches {
  return {
    nodeCache: new IdCache<Node>(),
    faceplateItemsCache: new IdCache<readonly FaceplateItem[]>(),
    chassisNodeCaches: createChassisNodeCaches(),
    rackSnapshotRef: new StableRef<RackSnapshot>(),
    itemsRef: new StableRef<readonly FaceplateItem[]>(),
    shelfRef: new StableRef<ShelfView>(),
    placementRef: new StableRef<import('./rows').SurfacePlacement>(),
    portalGroupRef: new StableRef<PortalGroup>(),
    prevNodes: null,
  };
}

export interface BuildDrawingNodesInput {
  view: ClosetView;
  rowViews: readonly RowView[];
  rowLayouts: readonly RowLayout[];
  rackPositions: Readonly<Record<string, { x: number; y: number }>>;
  cameraStop: CameraStop;
  elevationFor: (rackId: string) => Facing;
  canDraw: boolean;
  portSheath: ReadonlyMap<string, Sheath>;
  dragOverride: { id: string; position: { x: number; y: number } } | null;
  selectedChassisId: string | null;
  selected: Selection | null;
  handleSelectPort: (portId: string) => void;
  handleSelectFixture: (fixtureId: string) => void;
  onFlipRow: (key: string) => void;
  onFlipRack: (rackId: string) => void;
  onSelectShelf: (shelfId: string) => void;
  onOpenShelfOccupant: (occupantId: string, centreX: number, centreY: number) => void;
  onHoverInlet: (cableId: string | null) => void;
  surfacesLayout: SurfacesLayout;
  portalGroups: readonly PortalGroup[];
}

export interface BuildDrawingNodesResult {
  nodes: Node[];
  /** The selected chassis's own flow-space centre, for the config-drawer
   * recentre — `null` when nothing chassis-shaped is selected. */
  selectedChassisFlowCentre: { x: number; y: number } | null;
  /** The selected port's owning box's own flow-space centre, for "go to
   * end" — `null` when no port is selected or its owner is not on `nodes`. */
  selectedPortOwnerCentre: { x: number; y: number } | null;
}

/** Which React Flow node a port's own owning box is — the chassis node,
 * the shelf node or the surface node, `null` when this view carries no such port. */
function ownerNodeIdForPort(view: ClosetView, portId: string): string | null {
  const location = locatePort(view, portId);
  if (location == null) return null;
  if (location.place === 'chassis') return chassisNodeId(location.chassis.id);
  if (location.place === 'shelf') return shelfNodeId(location.shelf.id);
  return surfaceNodeId(location.surface.id);
}

function sameNodesArray(a: readonly Node[], b: readonly Node[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export function buildDrawingNodes(input: BuildDrawingNodesInput, caches: DrawingNodeCaches): BuildDrawingNodesResult {
  const {
    view,
    rowViews,
    rowLayouts,
    rackPositions,
    cameraStop,
    elevationFor,
    canDraw,
    portSheath,
    dragOverride,
    selectedChassisId,
    selected,
    handleSelectPort,
    handleSelectFixture,
    onFlipRow,
    onFlipRack,
    onSelectShelf,
    onOpenShelfOccupant,
    onHoverInlet,
    surfacesLayout,
    portalGroups,
  } = input;

  const nodes: Node[] = [];
  let selectedChassisFlowCentre: { x: number; y: number } | null = null;

  rowLayouts.forEach((layout, rowIndex) => {
    const y = rowBandY(rowLayouts, rowIndex, rackNodeHeight, ROW_GAP_PX);
    if (cameraStop === 'closet' && layout.racks.length > 0) {
      const key = rowKey(rowViews[rowIndex]!, rowIndex);
      const bandHeight = Math.max(0, ...layout.racks.map((r) => rackNodeHeight(r)));
      nodes.push(
        caches.nodeCache.get(rowLabelNodeId(key), [layout.label, layout.elevation, bandHeight, y], () => ({
          id: rowLabelNodeId(key),
          type: 'rowLabel',
          position: { x: -(ROW_LABEL_WIDTH + RACK_GAP_PX / 2), y },
          draggable: false,
          selectable: false,
          width: ROW_LABEL_WIDTH,
          height: bandHeight,
          style: { width: ROW_LABEL_WIDTH, height: bandHeight },
          data: {
            label: layout.label,
            elevation: layout.elevation,
            onFlip: () => onFlipRow(key),
          } satisfies RowLabelNodeData,
        })),
      );
    }

    for (const rack of layout.racks) {
      const pos = rackPositions[rack.id] ?? { x: 0, y };
      const elevation = elevationFor(rack.id);
      const freshItems = caches.faceplateItemsCache.get(rack.id, [rack.chassis, elevation], () => faceplateItems(rack.chassis, elevation));
      const items = caches.itemsRef.get(rack.id, freshItems, faceplateItemsEqual);

      const rackSnapshot = caches.rackSnapshotRef.get(
        rack.id,
        { label: rack.label, heightU: rack.heightU, freeRuns: sortFreeRuns(rack.freeRuns) },
        rackSnapshotEqual,
      );
      nodes.push(
        caches.nodeCache.get(rackNodeId(rack.id), [rackSnapshot, items, elevation, pos.x, pos.y, canDraw], () => ({
          id: rackNodeId(rack.id),
          type: 'rack',
          position: pos,
          draggable: canDraw,
          selectable: true,
          width: RACK_NODE_WIDTH,
          height: rackNodeHeight(rack),
          style: { width: RACK_NODE_WIDTH, height: rackNodeHeight(rack) },
          data: {
            rack,
            chassisItems: items,
            elevation,
            onFlip: () => onFlipRack(rack.id),
            onHoverInlet,
          } satisfies RackNodeData,
        })),
      );

      for (const item of items) {
        const { chassis } = item;
        const documentPosition = {
          x: pos.x + RAIL_PX,
          y: pos.y + RACK_HEADER_PX + uToOffsetPx(rack.heightU, chassis.positionU, chassis.heightU),
        };
        const nodePosition =
          dragOverride != null && dragOverride.id === chassisNodeId(chassis.id) ? dragOverride.position : documentPosition;
        nodes.push(
          buildChassisNode(
            chassis,
            item.ports,
            item.inlets,
            elevation,
            nodePosition,
            canDraw,
            portSheath,
            handleSelectPort,
            RACK_INNER_PX,
            chassis.heightU * U_PX,
            caches.chassisNodeCaches,
          ),
        );
        if (chassis.id === selectedChassisId) {
          selectedChassisFlowCentre = {
            x: nodePosition.x + RACK_INNER_PX / 2,
            y: nodePosition.y + (chassis.heightU * U_PX) / 2,
          };
        }
      }

      for (const shelf of rack.shelves) {
        const shelfPosition = {
          x: pos.x + RAIL_PX,
          y: pos.y + RACK_HEADER_PX + uToOffsetPx(rack.heightU, shelf.positionU, shelf.heightU),
        };
        const shelfSnapshot = caches.shelfRef.get(shelf.id, shelf, shelfEqual);
        nodes.push(
          caches.nodeCache.get(
            shelfNodeId(shelf.id),
            [shelfSnapshot, elevation, portSheath, shelfPosition.x, shelfPosition.y, handleSelectPort],
            () => ({
              id: shelfNodeId(shelf.id),
              type: 'shelf',
              position: shelfPosition,
              draggable: false,
              selectable: false,
              zIndex: 10,
              width: RACK_INNER_PX,
              height: shelf.heightU * U_PX,
              style: { width: RACK_INNER_PX, height: shelf.heightU * U_PX },
              data: {
                shelf: shelfSnapshot,
                elevation,
                slotCount: null,
                onSelectShelf: () => onSelectShelf(shelf.id),
                onSelectOccupant: (occupantId: string) => {
                  const centreX = shelfPosition.x + RACK_INNER_PX / 2;
                  const centreY = shelfPosition.y + (shelf.heightU * U_PX) / 2;
                  onOpenShelfOccupant(occupantId, centreX, centreY);
                },
                onSelectPort: handleSelectPort,
                portSheath,
              } satisfies ShelfPlateNodeData,
            }),
          ),
        );
      }
    }
  });

  for (const placement of [...surfacesLayout.panels, ...(surfacesLayout.floor ? [surfacesLayout.floor] : [])]) {
    const placementSnapshot = caches.placementRef.get(placement.surface.id, placement, placementEqual);
    nodes.push(
      caches.nodeCache.get(
        surfaceNodeId(placement.surface.id),
        [placementSnapshot, portSheath, handleSelectPort, handleSelectFixture],
        () => ({
          id: surfaceNodeId(placement.surface.id),
          type: 'surface',
          position: { x: placementSnapshot.x, y: placementSnapshot.y },
          draggable: false,
          selectable: false,
          width: placementSnapshot.widthPx,
          height: placementSnapshot.heightPx,
          style: { width: placementSnapshot.widthPx, height: placementSnapshot.heightPx },
          data: {
            placement: placementSnapshot,
            uPx: U_PX,
            onSelectPort: handleSelectPort,
            onSelectFixture: handleSelectFixture,
            portSheath,
          } satisfies SurfaceNodeData,
        }),
      ),
    );
  }

  const selectedPortId = selected?.kind === 'port' ? selected.id : null;
  let selectedPortOwnerCentre: { x: number; y: number } | null = null;
  if (selectedPortId != null) {
    const ownerNodeId = ownerNodeIdForPort(view, selectedPortId);
    const ownerNode = ownerNodeId != null ? nodes.find((n) => n.id === ownerNodeId) : undefined;
    if (ownerNode != null) {
      const style = ownerNode.style ?? {};
      const w = typeof style.width === 'number' ? style.width : 0;
      const h = typeof style.height === 'number' ? style.height : 0;
      selectedPortOwnerCentre = { x: ownerNode.position.x + w / 2, y: ownerNode.position.y + h / 2 };
    }
  }

  const traySlots: Record<string, number> = {};
  for (const group of portalGroups) {
    const pos = rackPositions[group.rackId];
    if (pos == null) continue;
    const rack = view.racks.find((r) => r.id === group.rackId);
    if (rack == null) continue;
    const slotKey = `${group.rackId}|${group.side}`;
    const slot = traySlots[slotKey] ?? 0;
    traySlots[slotKey] = slot + 1;
    const y =
      group.side === 'above'
        ? pos.y - (slot + 1) * (PORTAL_TRAY_HEIGHT + TRAY_GAP_PX)
        : pos.y + rackNodeHeight(rack) + TRAY_GAP_PX + slot * (PORTAL_TRAY_HEIGHT + TRAY_GAP_PX);
    const groupSnapshot = caches.portalGroupRef.get(group.key, group, portalGroupEqual);
    nodes.push(
      caches.nodeCache.get(trayNodeId(group.key), [groupSnapshot, pos.x, y], () => ({
        id: trayNodeId(group.key),
        type: 'tray',
        position: { x: pos.x, y },
        draggable: false,
        selectable: false,
        width: RACK_NODE_WIDTH,
        height: PORTAL_TRAY_HEIGHT,
        style: { width: RACK_NODE_WIDTH, height: PORTAL_TRAY_HEIGHT },
        data: {
          label: groupSnapshot.label,
          countLabel: portalCountLabel(groupSnapshot),
          side: groupSnapshot.side,
          trayKey: groupSnapshot.key,
        } satisfies PortalTrayNodeData,
      })),
    );
  }

  // Drop any entry this call never asked for — a rack, chassis, shelf,
  // surface, tray or item a document edit removed.
  caches.nodeCache.sweep();
  caches.faceplateItemsCache.sweep();
  caches.chassisNodeCaches.nodeCache.sweep();
  caches.chassisNodeCaches.chassisRef.sweep();
  caches.rackSnapshotRef.sweep();
  caches.itemsRef.sweep();
  caches.shelfRef.sweep();
  caches.placementRef.sweep();
  caches.portalGroupRef.sweep();

  const stableNodes = caches.prevNodes != null && sameNodesArray(caches.prevNodes, nodes) ? caches.prevNodes : nodes;
  caches.prevNodes = stableNodes;

  return { nodes: stableNodes, selectedChassisFlowCentre, selectedPortOwnerCentre };
}
