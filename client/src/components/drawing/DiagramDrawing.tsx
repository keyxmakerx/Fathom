import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  ConnectionMode,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type OnMove,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import '../../styles/drawing.css';

import type { CableView, ClosetView, Selection } from './contract';
import { BOX_H, BOX_W, diagramLines, layoutDiagram, orthRoute, type Route } from './diagram';
import { MAX_ZOOM, MIN_ZOOM, U_PX, zoomBandAt } from './geometry';
import { StubTags } from './StubTags';
import { SHEATH_VAR, needsHairlineOutline } from './sheath';
import { isFarApart, stubTagText, type StubEnd } from './stubs';

/** The Diagram look: plain labelled boxes joined by square-cornered lines in the
 * sheath colour. It shows the same document as the Rack look; devices are added,
 * moved and cabled in Rack. */

interface BoxData extends Record<string, unknown> {
  hostname: string;
  selected: boolean;
}

function DiagramBoxNode({ data }: NodeProps<Node<BoxData, 'diagramBox'>>) {
  return (
    <div className={data.selected ? 'drawing-diagram-box drawing-diagram-box--selected' : 'drawing-diagram-box'}>
      <span className="drawing-diagram-box__name">{data.hostname === '' ? 'unnamed device' : data.hostname}</span>
      <Handle type="source" position={Position.Right} className="drawing-diagram-box__handle" isConnectable={false} />
      <Handle type="target" position={Position.Left} className="drawing-diagram-box__handle" isConnectable={false} />
    </div>
  );
}

interface LineData extends Record<string, unknown> {
  cable: CableView;
  route: Route;
  stub?: [StubEnd, StubEnd];
  onSelect: (cableId: string) => void;
  onPanTo: (chassisId: string) => void;
}

const WIDTH_VAR: Record<CableView['kind'], string> = { copper: 'var(--cable-copper)', fibre: 'var(--cable-fibre)', power: 'var(--cable-power)' };

function DiagramLineEdge({ data }: EdgeProps<Edge<LineData, 'diagramLine'>>) {
  if (!data) return null;
  const { cable, route, stub, onSelect, onPanTo } = data;
  const colour = SHEATH_VAR[cable.sheath ?? 'grey'];
  const width = WIDTH_VAR[cable.kind];
  if (stub != null) {
    return (
      <g className="drawing-cable drawing-cable--stub" data-cable-id={cable.id}>
        <StubTags id={cable.id} colour={colour} width={width} points={[route.a, route.b]} dirs={[route.a, route.b]} stubs={stub} onPanTo={onPanTo} />
      </g>
    );
  }
  return (
    <g
      className="drawing-cable"
      data-cable-id={cable.id}
      style={{ cursor: 'pointer' }}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(cable.id);
      }}
    >
      {needsHairlineOutline(cable.sheath ?? 'grey') && <path d={route.d} fill="none" stroke="var(--hairline)" strokeWidth={`calc(${width} + 2px)`} strokeLinejoin="miter" />}
      <path d={route.d} fill="none" stroke={colour} strokeWidth={width} strokeLinejoin="miter" strokeLinecap="butt" />
      <path d={route.d} fill="none" stroke="transparent" strokeWidth={14} pointerEvents="stroke" />
    </g>
  );
}

const nodeTypes = { diagramBox: DiagramBoxNode };
const edgeTypes = { diagramLine: DiagramLineEdge };

export interface DiagramDrawingProps {
  view: ClosetView;
  selected: Selection | null;
  onSelect: (selection: Selection | null) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  fitRequest?: number;
}

function DiagramInner({ view, selected, onSelect, zoom, onZoomChange, fitRequest }: DiagramDrawingProps) {
  const rf = useReactFlow();
  const [band, setBand] = useState(() => zoomBandAt(Math.max(zoom, 1)));

  const boxes = useMemo(() => layoutDiagram(view), [view]);
  const selectedId = selected?.kind === 'chassis' ? selected.id : null;
  const selectedCableId = selected?.kind === 'cable' ? selected.id : null;

  const panTo = useCallback(
    (chassisId: string) => {
      const b = boxes.find((x) => x.id === chassisId);
      if (b != null) void rf.setCenter(b.x + BOX_W / 2, b.y + BOX_H / 2, { zoom: rf.getZoom(), duration: 300 });
    },
    [boxes, rf],
  );

  const nodes: Node[] = useMemo(
    () =>
      boxes.map((b) => ({
        id: b.id,
        type: 'diagramBox',
        position: { x: b.x, y: b.y },
        width: b.w,
        height: b.h,
        draggable: false,
        data: { hostname: b.hostname, selected: b.id === selectedId } satisfies BoxData,
      })),
    [boxes, selectedId],
  );

  const edges: Edge[] = useMemo(() => {
    const byId = new Map(boxes.map((b) => [b.id, b]));
    return diagramLines(view, new Set(byId.keys())).map((line) => {
      const ba = byId.get(line.a)!;
      const bb = byId.get(line.b)!;
      const route = orthRoute(ba, bb, line.lane);
      let stub: [StubEnd, StubEnd] | undefined;
      if (isFarApart({ x: ba.x + ba.w / 2, y: ba.y + ba.h / 2 }, { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 })) {
        const tag = (to: typeof ba): StubEnd => ({ text: stubTagText(to.hostname, to.rackLabel), panTo: to.id });
        stub = [tag(bb), tag(ba)];
      }
      return {
        id: line.cable.id,
        type: 'diagramLine',
        source: line.a,
        target: line.b,
        selectable: false,
        className: line.cable.id === selectedCableId ? 'drawing-diagram-line--selected' : undefined,
        data: { cable: line.cable, route, stub, onSelect: (id: string) => onSelect({ kind: 'cable', id }), onPanTo: panTo } satisfies LineData,
      } satisfies Edge<LineData, 'diagramLine'>;
    });
  }, [boxes, view, selectedCableId, onSelect, panTo]);

  // The bar's Fit button and its zoom percentage, as the Rack look obeys them.
  const prevFit = useRef(fitRequest);
  useEffect(() => {
    if (fitRequest == null || fitRequest === prevFit.current) return;
    prevFit.current = fitRequest;
    void rf.fitView({ padding: 0.15, duration: 300 });
  }, [fitRequest, rf]);
  useEffect(() => {
    void rf.fitView({ padding: 0.15 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once on mount
  }, []);
  useEffect(() => {
    const live = rf.getViewport();
    if (Math.round(live.zoom * 100) === zoom) return;
    void rf.setViewport({ ...live, zoom: zoom / 100 });
  }, [zoom, rf]);

  const handleMove: OnMove = useCallback((_e, vp) => setBand(zoomBandAt(Math.round(vp.zoom * 1000) / 10)), []);
  const handleMoveEnd: OnMove = useCallback(
    (_e, vp) => {
      const pct = Math.round(vp.zoom * 100);
      if (pct !== zoom) onZoomChange(pct);
    },
    [zoom, onZoomChange],
  );

  return (
    <div className="drawing drawing--diagram" data-look="diagram" data-zoom-band={band}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose}
        nodesConnectable={false}
        nodesDraggable={false}
        elementsSelectable={false}
        onNodeClick={(_e, node) => onSelect({ kind: 'chassis', id: node.id })}
        onPaneClick={() => onSelect(null)}
        onMove={handleMove}
        onMoveEnd={handleMoveEnd}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={U_PX} size={1} />
      </ReactFlow>
    </div>
  );
}

export function DiagramDrawing(props: DiagramDrawingProps) {
  return (
    <ReactFlowProvider>
      <DiagramInner {...props} />
    </ReactFlowProvider>
  );
}
