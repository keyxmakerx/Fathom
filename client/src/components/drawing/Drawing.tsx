import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import {
  Background,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type NodeMouseHandler,
  type OnNodeDrag,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import '../../styles/drawing.css';

import type { ClosetView, DrawingActions, RackView, Selection } from './contract';
import { decodePaletteDrag, PALETTE_DRAG_MIME } from './dnd';
import {
  CAMERA_STOPS,
  RACK_HEADER_PX,
  RACK_INNER_PX,
  RAIL_PX,
  U_PX,
  overlapsRack,
  portOpacity as portOpacityAt,
  rackAtPoint,
  snapDropToU,
  uToOffsetPx,
} from './geometry';
import { ChassisNode, type ChassisNodeData, type ChassisNodeType } from './ChassisNode';
import { RACK_NODE_WIDTH, RackNode, rackNodeHeight, type RackNodeData, type RackNodeType } from './RackNode';
import { chassisNodeId, parseNodeId, rackNodeId } from './nodeId';

const NODE_TYPES = { rack: RackNode, chassis: ChassisNode };

/** Session-only gap between racks placed side by side — not a document
 * fact, never saved (brief: "remembered in component state only in this
 * session"; persisting layout is `OPEN-QUESTIONS` D5). */
const RACK_GAP_PX = 96;

/** How long the shake plays before the rejected drop's mark clears —
 * UI-SPEC "Motion" #2: "target shakes once sideways, lead springs back."
 * Matches `drawing.css`'s `--drawing-shake-ms`. */
const SHAKE_MS = 220;

export interface DrawingProps extends DrawingActions {
  view: ClosetView;
  selected: Selection | null;
  /** The bar's zoom percentage, e.g. `100` — `Shell`'s own `zoom` prop
   * convention. Kept in agreement with React Flow's viewport: this
   * component is the one place that converts between the two. */
  zoom: number;
  onZoomChange: (zoom: number) => void;
}

type AnyRackNode = RackNodeType;
type AnyChassisNode = ChassisNodeType;
type FlowNode = AnyRackNode | AnyChassisNode;

type RackPositions = Record<string, { x: number; y: number }>;
type DropPreview = Record<string, { fromU: number; toU: number; valid: boolean }>;

function DrawingInner({ view, selected, zoom, onZoomChange, onPlace, onMove, onSelect }: DrawingProps) {
  const rf = useReactFlow<FlowNode>();

  const [rackPositions, setRackPositions] = useState<RackPositions>({});
  const [dragOverride, setDragOverride] = useState<Record<string, { x: number; y: number }>>({});
  const [dropPreview, setDropPreview] = useState<DropPreview>({});
  const [shakingId, setShakingId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: Math.max(zoom, 1) / 100 });
  const shakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // New racks land side by side in arrival order; a rack already placed
  // keeps its session position even if the view re-orders around it.
  useEffect(() => {
    setRackPositions((prev) => {
      const known = view.racks.filter((r) => prev[r.id] == null);
      if (known.length === 0) return prev;
      let cursorX = Object.values(prev).reduce((max, p) => Math.max(max, p.x + RACK_NODE_WIDTH + RACK_GAP_PX), 0);
      const next = { ...prev };
      for (const rack of known) {
        next[rack.id] = { x: cursorX, y: 0 };
        cursorX += RACK_NODE_WIDTH + RACK_GAP_PX;
      }
      return next;
    });
  }, [view.racks]);

  // "Entering the Racks place lands at the rack stop with the first rack
  // fitted, not at an arbitrary corner" — once on mount and whenever the
  // set of racks changes, fit the camera to whatever racks are now placed,
  // never past the rack stop's own zoom (a short rack should not zoom in
  // tighter than "the rack stop" just because it is short). Waits for
  // `rackPositions` to actually carry every current rack's id, since a
  // brand-new rack's real position lands one render after `view.racks`
  // does (the effect above); fitting against the `{x:0,y:0}` fallback
  // would fit an empty corner instead. `fitView`'s own `onViewportChange`
  // is what keeps the bar's zoom number in agreement — the same path a
  // manual scroll-zoom already takes (`handleViewportChange`, below).
  const rackIdsKey = view.racks.map((r) => r.id).join('|');
  const allRacksPositioned = view.racks.every((r) => rackPositions[r.id] != null);
  useEffect(() => {
    if (!allRacksPositioned || view.racks.length === 0) return;
    const raf = requestAnimationFrame(() => {
      void rf.fitView({
        nodes: view.racks.map((r) => ({ id: rackNodeId(r.id) })),
        padding: 0.1,
        maxZoom: CAMERA_STOPS.rack / 100,
      });
    });
    return () => cancelAnimationFrame(raf);
    // `view.racks` itself is deliberately not a dependency: `rackIdsKey` is
    // its content identity (which racks exist), and that is the only
    // change this effect should react to. The array's own object identity
    // is not guaranteed stable across a caller's re-renders (nothing
    // requires the caller to memoise it), and re-fitting on every render
    // would fight a person's own scroll-zoom.
  }, [rackIdsKey, allRacksPositioned, rf]);

  useEffect(() => {
    setViewport((v) => (Math.round(v.zoom * 100) === zoom ? v : { ...v, zoom: zoom / 100 }));
  }, [zoom]);

  const handleViewportChange = useCallback(
    (vp: Viewport) => {
      setViewport(vp);
      const pct = Math.round(vp.zoom * 100);
      if (pct !== zoom) onZoomChange(pct);
    },
    [zoom, onZoomChange],
  );

  const triggerShake = useCallback((id: string) => {
    if (shakeTimer.current != null) clearTimeout(shakeTimer.current);
    setShakingId(id);
    shakeTimer.current = setTimeout(() => setShakingId(null), SHAKE_MS);
  }, []);

  useEffect(() => () => {
    if (shakeTimer.current != null) clearTimeout(shakeTimer.current);
  }, []);

  const zoomPercent = Math.round(viewport.zoom * 100);

  const nodes: Node[] = [];
  for (const rack of view.racks) {
    const pos = rackPositions[rack.id] ?? { x: 0, y: 0 };
    const rackData: RackNodeData = {
      rack,
      selected: selected?.kind === 'rack' && selected.id === rack.id,
      dropPreview: dropPreview[rack.id] ?? null,
      shaking: shakingId === rackNodeId(rack.id),
    };
    nodes.push({
      id: rackNodeId(rack.id),
      type: 'rack',
      position: pos,
      draggable: true,
      selectable: true,
      style: { width: RACK_NODE_WIDTH, height: rackNodeHeight(rack) },
      data: rackData,
    } satisfies AnyRackNode);

    for (const chassis of rack.chassis) {
      if (chassis.face !== 'front') continue;
      const id = chassisNodeId(chassis.id);
      const basePosition = {
        x: pos.x + RAIL_PX,
        y: pos.y + RACK_HEADER_PX + uToOffsetPx(rack.heightU, chassis.positionU, chassis.heightU),
      };
      const chassisData: ChassisNodeData = {
        chassis,
        selected: selected?.kind === 'chassis' && selected.id === chassis.id,
        portOpacity: portOpacityAt(zoomPercent),
        onSelectPort: (portId: string) => onSelect({ kind: 'port', id: portId }),
      };
      nodes.push({
        id,
        type: 'chassis',
        position: dragOverride[id] ?? basePosition,
        draggable: true,
        selectable: true,
        zIndex: 10,
        style: { width: RACK_INNER_PX, height: chassis.heightU * U_PX },
        data: chassisData,
      } satisfies AnyChassisNode);
    }
  }

  const handleNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      const parsed = parseNodeId(node.id);
      if (parsed == null) return;
      onSelect(parsed.kind === 'rack' ? { kind: 'rack', id: parsed.id } : { kind: 'chassis', id: parsed.id });
    },
    [onSelect],
  );

  const chassisHeightUFor = (node: FlowNode): number =>
    node.type === 'chassis' ? (node.data as ChassisNodeData).chassis.heightU : 1;

  const handleNodeDrag: OnNodeDrag = useCallback(
    (_event, node) => {
      const parsed = parseNodeId(node.id);
      if (parsed?.kind !== 'chassis') return;
      setDragOverride((prev) => ({ ...prev, [node.id]: node.position }));

      const heightU = chassisHeightUFor(node as FlowNode);
      const centre = { x: node.position.x + RACK_INNER_PX / 2, y: node.position.y + (heightU * U_PX) / 2 };
      const rack = rackAtPoint<RackView>(view.racks, rackPositions, centre, RACK_NODE_WIDTH);
      if (rack == null) {
        setDropPreview({});
        return;
      }
      const rackPos = rackPositions[rack.id];
      const offsetFromTop = node.position.y - rackPos.y - RACK_HEADER_PX;
      const positionU = snapDropToU(rack.heightU, offsetFromTop, heightU);
      const valid = !overlapsRack(rack, { id: parsed.id, positionU, heightU });
      setDropPreview({ [rack.id]: { fromU: positionU, toU: positionU + heightU - 1, valid } });
    },
    [view.racks, rackPositions],
  );

  const handleNodeDragStop: OnNodeDrag = useCallback(
    (_event, node) => {
      const parsed = parseNodeId(node.id);
      if (parsed == null) return;

      if (parsed.kind === 'rack') {
        setRackPositions((prev) => ({ ...prev, [parsed.id]: node.position }));
        return;
      }

      const heightU = chassisHeightUFor(node as FlowNode);
      const centre = { x: node.position.x + RACK_INNER_PX / 2, y: node.position.y + (heightU * U_PX) / 2 };
      const rack = rackAtPoint<RackView>(view.racks, rackPositions, centre, RACK_NODE_WIDTH);

      setDragOverride((prev) => {
        const next = { ...prev };
        delete next[node.id];
        return next;
      });
      setDropPreview({});

      if (rack == null) {
        triggerShake(node.id);
        return;
      }
      const rackPos = rackPositions[rack.id];
      const offsetFromTop = node.position.y - rackPos.y - RACK_HEADER_PX;
      const positionU = snapDropToU(rack.heightU, offsetFromTop, heightU);
      if (overlapsRack(rack, { id: parsed.id, positionU, heightU })) {
        triggerShake(rackNodeId(rack.id));
        return;
      }
      onMove(parsed.id, rack.id, positionU);
    },
    [view.racks, rackPositions, onMove, triggerShake],
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(PALETTE_DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const raw = event.dataTransfer.getData(PALETTE_DRAG_MIME);
      if (!raw) return;
      event.preventDefault();
      const payload = decodePaletteDrag(raw);
      if (payload == null) return;

      const flowPoint = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const rack = rackAtPoint<RackView>(view.racks, rackPositions, flowPoint, RACK_NODE_WIDTH);
      if (rack == null) return;
      const rackPos = rackPositions[rack.id];
      const offsetFromTop = flowPoint.y - rackPos.y - RACK_HEADER_PX;
      const positionU = snapDropToU(rack.heightU, offsetFromTop, payload.rackUnits);
      if (overlapsRack(rack, { positionU, heightU: payload.rackUnits })) {
        triggerShake(rackNodeId(rack.id));
        return;
      }
      onPlace(rack.id, { vendor: payload.vendor, model: payload.model }, positionU);
    },
    [rf, view.racks, rackPositions, onPlace, triggerShake],
  );

  return (
    <div className="drawing" onDrop={handleDrop} onDragOver={handleDragOver}>
      <ReactFlow
        nodes={nodes}
        edges={[]}
        nodeTypes={NODE_TYPES}
        viewport={viewport}
        onViewportChange={handleViewportChange}
        onNodeClick={handleNodeClick}
        onPaneClick={() => onSelect(null)}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        minZoom={CAMERA_STOPS.closet / 100 - 0.1}
        maxZoom={CAMERA_STOPS.faceplate / 100 + 0.3}
        panOnDrag
        panOnScroll={false}
        zoomOnScroll
        nodesConnectable={false}
        elementsSelectable
        deleteKeyCode={null}
      >
        <Background gap={U_PX} size={1} />
      </ReactFlow>
    </div>
  );
}

/** The rack drawing: one React Flow node per rack and one per chassis, per
 * the brief. Wrapped in its own `ReactFlowProvider` so `useReactFlow` (needed
 * for the palette drop's `screenToFlowPosition`) is available without the
 * caller having to know that. */
export function Drawing(props: DrawingProps) {
  return (
    <ReactFlowProvider>
      <DrawingInner {...props} />
    </ReactFlowProvider>
  );
}
