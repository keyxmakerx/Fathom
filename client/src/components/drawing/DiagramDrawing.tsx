import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Background,
  ConnectionMode,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
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
import { BOX_H, BOX_W, diagramLines, layoutDiagram } from './diagram';
import { routeDiagram, type Route } from './diagramRoutes';
import { DIAGRAM_MAX_ZOOM, MIN_ZOOM, U_PX, zoomBandAt } from './geometry';
import { DeviceIcon, ICON_H, ICON_W, iconForRole, type IconKind } from './deviceIcons';
import type { DiagramStyle } from './diagramStyle';
import { CableCheckBadge, CheckBadge } from '../checks/CheckBadge';
import { StubTags } from './StubTags';
import { cableCandidates, placeLabels, type LayerWords } from './layerLabels';
import { CollabLayer } from '../collab/CollabLayer';
import { CanvasTools } from './CanvasTools';
import { useWheelMode } from './canvasPrefs';
import { useSettledView } from './settledView';
import { endOffScreen, stubTagText, type StubEnd } from './stubs';
import { useCameraHub, type CameraHub } from './camera';
import { CanvasMiniMap } from './CanvasMiniMap';
import { useLearn } from '../learn/context';
import '../learn/learn.css';
import type { LearnNote } from '../learn/learnNotes';
import type { OverlayView } from '../../document/overlays';
import { overlayShapes } from './overlayDraw';
import { OverlayCard, OverlayLayer } from './OverlayLayer';
import type { RoutingMarks, RoutingWord } from './routingLens';
import { speedWidth, TRUNK_MIN_W, type LinksLine, type LinksMarks } from './linksLens';

/** The Routing lens's table picker: the tables to choose from, the lit one, and what it lights. */
export interface TableChoice {
  names: string[];
  current: string;
  lit: { chassis: ReadonlySet<string>; cables: ReadonlySet<string> };
  onPick: (name: string) => void;
}
import { useChecksApi } from '../checks/checksStore';
import { revealedResult } from '../trace/tracePlayback';
import { useTraceRevealed, useTraceResult } from '../trace/traceStore';
import '../trace/trace.css';
import '../trace/tracePlay.css';
import { diagramTrace, numberText } from './diagramTrace';

/** The Diagram look: plain labelled boxes joined by square-cornered lines in the
 * sheath colour. It shows the same document as the Rack look; devices are added,
 * moved and cabled in Rack. */

interface BoxData extends Record<string, unknown> {
  /** The chassis id Checks counts against. */
  deviceId: string;
  hostname: string;
  selected: boolean;
  /** Show-menu words under the name (tags). */
  words: string[];
  /** Icons style: the outline icon for the device's role; null draws the box. */
  icon: IconKind | null;
  /** The Routing lens's words, above the Show menu's. */
  lens: RoutingWord[];
  /** A trace stopped short here: the box takes the caution edge. */
  stopped: boolean;
}

function DiagramBoxNode({ data }: NodeProps<Node<BoxData, 'diagramBox'>>) {
  const cls = ['drawing-diagram-box', data.icon != null && 'drawing-diagram-box--icon', data.selected && 'drawing-diagram-box--selected', data.stopped && 'drawing-diagram-box--stop'].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      {data.icon != null && <DeviceIcon kind={data.icon} />}
      <span className={data.icon != null ? 'drawing-diagram-box__text drawing-diagram-box__text--below' : 'drawing-diagram-box__text'}>
        <span className="drawing-diagram-box__name">{data.hostname === '' ? 'unnamed device' : data.hostname}</span>
        {data.lens.map((w) => (
          <span key={w.text} className={w.caution ? 'drawing-diagram-box__lens drawing-diagram-box__lens--caution' : 'drawing-diagram-box__lens'} data-testid="routing-lens-word">
            {w.text}
          </span>
        ))}
        {data.words.length > 0 && <span className="drawing-diagram-box__words">{data.words.join(' · ')}</span>}
      </span>
      <CheckBadge id={data.deviceId} />
      <Handle type="source" position={Position.Right} className="drawing-diagram-box__handle" isConnectable={false} />
      <Handle type="target" position={Position.Left} className="drawing-diagram-box__handle" isConnectable={false} />
    </div>
  );
}

interface LineData extends Record<string, unknown> {
  cable: CableView;
  route: Route;
  stub?: [StubEnd, StubEnd];
  /** Selected, or its tag hovered: the whole cable draws even when its far end is off screen. */
  lit: boolean;
  /** A ticked VLAN group's trunk member: drawn dashed. */
  dashed: boolean;
  /** On a path trace's walk: drawn heavier. */
  onPath: boolean;
  /** Another cable is lit: this one fades to the phantom level. */
  dimmed: boolean;
  /** The Links lens, while it is lit: this line's VLAN colour, trunk and speed. */
  links?: LinksLine | null;
  onSelect: (cableId: string) => void;
  onHover: (cableId: string | null) => void;
  onPanTo: (chassisId: string) => void;
}

const WIDTH_VAR: Record<CableView['kind'], string> = { copper: 'var(--cable-copper)', fibre: 'var(--cable-fibre)', power: 'var(--cable-power)' };

function DiagramLineEdge({ data }: EdgeProps<Edge<LineData, 'diagramLine'>>) {
  if (!data) return null;
  const { cable, route, stub, lit, dashed, onPath, dimmed, links, onSelect, onHover, onPanTo } = data;
  // Round 10: cables are plain ink on the canvas; sheath colours live in the Rack look only.
  // The Links lens (r109): an access line in its VLAN's colour, a trunk hollow, weight by speed.
  const colour = links?.slot != null ? `var(--vlan-${links.slot})` : 'var(--ink)';
  const linksW = links === undefined ? null : links === null ? speedWidth(null) : links.trunk ? Math.max(speedWidth(links.speedBps), TRUNK_MIN_W) : speedWidth(links.speedBps);
  const width = onPath ? '4px' : linksW != null ? `${linksW}px` : WIDTH_VAR[cable.kind];
  const hollow = links?.trunk === true && !onPath;
  const opacity = dimmed ? 'var(--phantom)' : 1;
  const tags =
    stub != null ? (
      <StubTags id={cable.id} colour={colour} width={width} points={[route.a, route.b]} dirs={[route.a, route.b]} stubs={stub} onPanTo={onPanTo} onHover={(on) => onHover(on ? cable.id : null)} />
    ) : null;
  if (tags != null && !lit) {
    return (
      <g className="drawing-cable drawing-cable--stub" data-cable-id={cable.id} style={{ opacity }}>
        {tags}
      </g>
    );
  }
  return (
    <g
      className="drawing-cable"
      data-cable-id={cable.id}
      style={{ cursor: 'pointer', opacity }}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(cable.id);
      }}
      onMouseEnter={() => onHover(cable.id)}
      onMouseLeave={() => onHover(null)}
    >
      <path d={route.d} fill="none" stroke={colour} strokeWidth={width} strokeLinejoin="miter" strokeLinecap="butt" strokeDasharray={dashed ? 'var(--cable-dash)' : undefined} />
      {hollow && <path d={route.d} fill="none" stroke="var(--page)" strokeWidth={`${linksW! * 0.4}px`} strokeLinejoin="miter" strokeLinecap="butt" strokeDasharray={dashed ? 'var(--cable-dash)' : undefined} data-testid="links-trunk-core" />}
      <path d={route.d} fill="none" stroke="transparent" strokeWidth={14} pointerEvents="stroke" />
      <CableCheckBadge id={cable.id} x={route.mid.x} y={route.mid.y} />
      {tags}
    </g>
  );
}

const nodeTypes = { diagramBox: DiagramBoxNode };

/** A Learn note's size and its leader's length, in screen pixels (learn.css draws the leader). */
const NOTE_W = 220;
const NOTE_H = 64;
const NOTE_GAP = 28;
/** The stop's caution box sits this far right of the box the walk stopped at. */
const STOP_GAP = 24;
const edgeTypes = { diagramLine: DiagramLineEdge };

export interface DiagramDrawingProps {
  view: ClosetView;
  selected: Selection | null;
  onSelect: (selection: Selection | null) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  fitRequest?: number;
  /** The Cables list's draw rule; `undefined` draws every cable, none dashed. */
  drawnCableIds?: ReadonlySet<string>;
  dashedCableIds?: ReadonlySet<string>;
  /** What the Show menu's ticked layers write on the canvas. */
  words?: LayerWords;
  /** Boxes (default) or Icons; the same boxes, the same lines. */
  style?: DiagramStyle;
  /** The place's handle on the camera, for the Views menu. */
  cameraHub?: CameraHub;
  /** The mini-map shows in the corner of the canvas. */
  minimap?: boolean;
  /** The Learn layer's notes (ADR-0066 item 1.2); each opens its explainer. */
  notes?: readonly LearnNote[];
  /** The VPNs layer: each VPN a badge with spokes, or one line for two members. */
  overlays?: readonly OverlayView[];
  /** The Routing lens, while it is lit: words on boxes and lines, switched lines dashed. */
  routing?: RoutingMarks;
  /** The Routing lens's table picker, when the design keeps a VRF: one table lit, the rest faded. */
  table?: TableChoice;
  /** The Links lens, while it is lit: VLAN colours, hollow trunks, weight by speed, and the Networks key. */
  links?: LinksMarks;
}

function DiagramInner({ view, selected, onSelect, zoom, onZoomChange, fitRequest, drawnCableIds, dashedCableIds: dashedIn, words: wordsIn, style = 'boxes', cameraHub, minimap, notes, overlays, routing, table, links }: DiagramDrawingProps) {
  const rf = useReactFlow();
  const learn = useLearn();
  // The Routing lens adds to what the Show menu writes: its word takes a line's middle, and a switched line is dashed.
  const words = useMemo((): LayerWords | undefined => {
    if (routing == null) return wordsIn;
    const cables = new Map(wordsIn?.cables ?? []);
    for (const [id, w] of routing.cables) cables.set(id, { ...cables.get(id), mid: w.mid });
    return { cables, devices: wordsIn?.devices ?? new Map() };
  }, [routing, wordsIn]);
  const dashedCableIds = useMemo(() => (routing == null ? dashedIn : new Set([...(dashedIn ?? []), ...routing.switched])), [routing, dashedIn]);
  const settled = useSettledView();
  const stubbedRef = useRef(new Set<string>());
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [band, setBand] = useState(() => zoomBandAt(Math.max(zoom, 1)));

  const roles = useMemo(() => new Map(view.racks.flatMap((r) => r.chassis.map((c) => [c.id, c.role] as const))), [view]);
  // Icons style: a device with an icon is just the icon (lines meet its edge, the name sits under it); the rest stay boxes.
  const boxes = useMemo(
    () =>
      layoutDiagram(view).map((b) =>
        style === 'icons' && iconForRole(roles.get(b.id)) != null ? { ...b, x: b.x + (b.w - ICON_W) / 2, y: b.y + (b.h - ICON_H) / 2 - 8, w: ICON_W, h: ICON_H } : b,
      ),
    [view, style, roles],
  );
  const selectedId = selected?.kind === 'chassis' ? selected.id : null;

  // A path trace (r101): what the walk touches stays; the rest fades; each hop is numbered. While it plays,
  // only the hops lit so far count.
  const traceFull = useTraceResult();
  const revealed = useTraceRevealed();
  const checks = useChecksApi();
  const trace = useMemo(() => {
    if (traceFull == null || (traceFull.hops.length === 0 && traceFull.stopped === '')) return null;
    const canon = checks?.store.get().canon ?? ((id: string) => id);
    return diagramTrace(revealedResult(traceFull, revealed), canon, boxes.map((b) => b.id), new Set(view.cables.map((c) => c.id)));
  }, [traceFull, revealed, checks, boxes, view]);
  const shapes = useMemo(() => (overlays == null || overlays.length === 0 ? [] : overlayShapes(overlays, boxes)), [overlays, boxes]);
  const [openOverlayId, setOpenOverlayId] = useState<string | null>(null);
  const openOverlay = overlays?.find((o) => o.id === openOverlayId) ?? null;
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
        className: (trace != null && !trace.boxes.has(b.id)) || (table != null && !table.lit.chassis.has(b.id)) ? 'trace-faded' : undefined,
        data: { deviceId: b.id, hostname: b.hostname, selected: b.id === selectedId, words: words?.devices.get(b.id) ?? [], icon: style === 'icons' ? iconForRole(roles.get(b.id)) : null, lens: routing?.devices.get(b.id) ?? [], stopped: trace?.stop?.boxId === b.id } satisfies BoxData,
      })),
    [boxes, selectedId, words, style, roles, routing, trace, table],
  );

  const litId = selectedCableId ?? hoverId;
  // Every line's route, worked out together so no two share a run and none crosses a box; panning does not redo it.
  const lines = useMemo(() => diagramLines(view, new Set(boxes.map((b) => b.id))), [view, boxes]);
  const routes = useMemo(() => routeDiagram(boxes, lines.map((l) => ({ id: l.cable.id, a: l.a, b: l.b }))), [boxes, lines]);
  const edges: Edge[] = useMemo(() => {
    const byId = new Map(boxes.map((b) => [b.id, b]));
    return lines
      .filter((line) => drawnCableIds == null || drawnCableIds.has(line.cable.id))
      .map((line) => {
      const ba = byId.get(line.a)!;
      const bb = byId.get(line.b)!;
      const route = routes.get(line.cable.id)!;
      let stub: [StubEnd, StubEnd] | undefined;
      const was = stubbedRef.current.has(line.cable.id);
      const centre = (b: typeof ba) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
      if (endOffScreen(centre(ba), settled.rect, settled.zoom, was) || endOffScreen(centre(bb), settled.rect, settled.zoom, was)) {
        stubbedRef.current.add(line.cable.id);
        const tag = (to: typeof ba): StubEnd => ({ text: stubTagText(to.hostname, to.rackLabel), panTo: to.id });
        stub = [tag(bb), tag(ba)];
      } else stubbedRef.current.delete(line.cable.id);
      const lit = line.cable.id === litId;
      return {
        id: line.cable.id,
        type: 'diagramLine',
        source: line.a,
        target: line.b,
        selectable: false,
        className: [line.cable.id === selectedCableId && 'drawing-diagram-line--selected', ((trace != null && !trace.cables.has(line.cable.id)) || (table != null && !table.lit.cables.has(line.cable.id))) && 'trace-faded'].filter(Boolean).join(' ') || undefined,
        data: { cable: line.cable, route, stub, lit, dashed: dashedCableIds?.has(line.cable.id) ?? false, onPath: trace?.cables.has(line.cable.id) ?? false, dimmed: litId != null && !lit, links: links == null ? undefined : (links.cables.get(line.cable.id) ?? null), onHover: setHoverId, onSelect: (id: string) => onSelect({ kind: 'cable', id }), onPanTo: panTo } satisfies LineData,
      } satisfies Edge<LineData, 'diagramLine'>;
    });
  }, [boxes, lines, routes, drawnCableIds, dashedCableIds, litId, selectedCableId, settled.rect, settled.zoom, onSelect, panTo, trace, table, links]);

  // The trace's numbers: on a box's top-left corner, or a line's middle; and the stop's caution box.
  const traceMarks = useMemo(() => {
    if (trace == null) return null;
    const dots: { key: string; text: string; x: number; y: number }[] = [];
    for (const b of boxes) {
      const ns = trace.boxNumbers.get(b.id);
      if (ns != null) dots.push({ key: `b:${b.id}`, text: numberText(ns), x: b.x, y: b.y });
    }
    for (const e of edges) {
      const ns = trace.cableNumbers.get(e.id);
      const d = e.data as LineData | undefined;
      if (ns != null && d != null) dots.push({ key: `c:${e.id}`, text: numberText(ns), x: d.route.mid.x, y: d.route.mid.y });
    }
    const at = trace.stop?.boxId != null ? boxes.find((b) => b.id === trace.stop!.boxId) : undefined;
    const stop = trace.stop == null ? null : { text: trace.stop.text, x: at != null ? at.x + at.w + STOP_GAP : 0, y: at != null ? at.y : 0 };
    return { dots, stop };
  }, [trace, boxes, edges]);

  // Show-menu words on the lines: placed so none overlap; a lost label is counted "+n".
  const labels = useMemo(() => {
    if (words == null || words.cables.size === 0) return [];
    const byId = new Map(boxes.map((b) => [b.id, b]));
    const nearby = lines
      .filter((l) => !stubbedRef.current.has(l.cable.id))
      // Only lines with an end near the screen: a big design mounts a screenful of words, not all of them.
      .filter((l) => {
        const r = settled.rect;
        const near = (b: { x: number; y: number }) => b.x > r.x0 - 300 && b.x < r.x1 + 300 && b.y > r.y0 - 300 && b.y < r.y1 + 300;
        return near(byId.get(l.a)!) || near(byId.get(l.b)!);
      })
      .map((l) => ({ id: l.cable.id, route: routes.get(l.cable.id)! }));
    return placeLabels(cableCandidates(nearby, words.cables, 1 / settled.zoom), boxes, 1 / settled.zoom);
  }, [words, boxes, lines, routes, settled.zoom, settled.rect, edges]);

  // The Learn layer's notes: to the right of a device, to the left of a cable's middle, each with a
  // short leader; a fixed on-screen size, pushed down past an earlier note rather than over it.
  const placedNotes = useMemo(() => {
    if (notes == null || notes.length === 0) return [];
    const scale = 1 / settled.zoom;
    const byId = new Map(boxes.map((b) => [b.id, b]));
    const byCable = new Map(lines.map((l) => [l.cable.id, l]));
    const W = NOTE_W * scale;
    const H = NOTE_H * scale;
    const GAP = NOTE_GAP * scale;
    const taken: { x: number; y: number }[] = [];
    const out: { note: LearnNote; x: number; y: number; side: 'right' | 'left' }[] = [];
    for (const note of notes) {
      let x: number;
      let y: number;
      let side: 'right' | 'left';
      if (note.anchor.kind === 'chassis') {
        const b = byId.get(note.anchor.id);
        if (b == null) continue;
        [x, y, side] = [b.x + b.w + GAP, b.y + b.h / 2, 'right'];
      } else {
        const l = byCable.get(note.anchor.id);
        if (l == null || stubbedRef.current.has(l.cable.id)) continue;
        const r = routes.get(l.cable.id)!;
        [x, y, side] = [r.mid.x - GAP, r.mid.y, 'left'];
      }
      const left = side === 'right' ? x : x - W;
      while (taken.some((t) => Math.abs(t.x - left) < W && Math.abs(t.y - y) < H)) y += H;
      taken.push({ x: left, y });
      out.push({ note, x, y, side });
    }
    return out;
  }, [notes, boxes, lines, routes, edges, settled.zoom]);

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
  // Follows the bar's zoom about the pane centre; skipped on mount, where the
  // fit above wins over the zoom the Rack look left behind.
  const zoomMounted = useRef(false);
  useEffect(() => {
    if (!zoomMounted.current) {
      zoomMounted.current = true;
      return;
    }
    if (Math.round(rf.getZoom() * 100) === zoom) return;
    void rf.zoomTo(zoom / 100);
  }, [zoom, rf]);
  useCameraHub(cameraHub);

  const [wheel, setWheel] = useWheelMode('zoom');
  const handleMove: OnMove = useCallback((_e, vp) => setBand(zoomBandAt(Math.round(vp.zoom * 1000) / 10)), []);
  const handleMoveEnd: OnMove = useCallback(
    (_e, vp) => {
      settled.settle(vp);
      const pct = Math.round(vp.zoom * 100);
      if (pct !== zoom) onZoomChange(pct);
    },
    [zoom, onZoomChange, settled.settle],
  );

  return (
    <div className="drawing drawing--diagram" data-look="diagram" data-style={style} data-zoom-band={band}>
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
        onPaneClick={() => {
          setOpenOverlayId(null);
          onSelect(null);
        }}
        onMove={handleMove}
        onMoveEnd={handleMoveEnd}
        minZoom={MIN_ZOOM}
        maxZoom={DIAGRAM_MAX_ZOOM}
        panOnScroll={wheel === 'scroll'}
        zoomOnScroll={wheel === 'zoom'}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={U_PX} size={1} />
        <CanvasMiniMap enabled={minimap === true} />
        {placedNotes.length > 0 && (
          <ViewportPortal>
            {placedNotes.map(({ note, x, y, side }) => (
              <button
                key={note.key}
                type="button"
                className={`learn-note learn-note--${side} nodrag nopan`}
                data-testid={`learn-note-${note.key}`}
                style={{ transform: `translate(${x}px, ${y}px) scale(${1 / settled.zoom}) translate(${side === 'right' ? '0%' : '-100%'}, -50%)`, width: NOTE_W }}
                onClick={() => learn?.openExplainer(note.explainerId)}
                title="Why? Opens the explainer"
              >
                <span className="learn-note__title">{note.title}</span>
                <span className="learn-note__line">{note.line}</span>
              </button>
            ))}
          </ViewportPortal>
        )}
        {shapes.length > 0 && <OverlayLayer shapes={shapes} overlays={overlays ?? []} openId={openOverlay?.id ?? null} onOpen={setOpenOverlayId} />}
        {labels.length > 0 && (
          <ViewportPortal>
            {labels.map((l) => (
              <span
                key={l.key}
                className={(trace ?? table?.lit) != null && !(trace ?? table!.lit).cables.has(l.key.slice(0, l.key.lastIndexOf(':'))) ? 'drawing-layer-label trace-faded-label' : 'drawing-layer-label'}
                style={{ transform: `translate(${l.x}px, ${l.y}px) scale(${1 / settled.zoom}) translate(${l.ax === 'start' ? '0%' : l.ax === 'end' ? '-100%' : '-50%'}, -50%)` }}
              >
                {l.text}
                {l.more > 0 && <span className="drawing-layer-label__more"> +{l.more}</span>}
              </span>
            ))}
          </ViewportPortal>
        )}
        {traceMarks != null && (
          <ViewportPortal>
            {traceMarks.dots.map((d) => (
              <span key={d.key} className="trace-dot" data-testid="diagram-trace-dot" style={{ transform: `translate(${d.x}px, ${d.y}px) translate(-50%, -50%)`, '--trace-x': `${d.x}px`, '--trace-y': `${d.y}px` } as CSSProperties}>
                {d.text}
              </span>
            ))}
            {traceMarks.stop != null && (
              <div className="drawing-trace-stop" role="note" data-testid="diagram-trace-stop" style={{ transform: `translate(${traceMarks.stop.x}px, ${traceMarks.stop.y}px)` }}>
                <span className="drawing-trace-stop__head">Stopped here</span>
                <span>Could not establish: {traceMarks.stop.text}</span>
              </div>
            )}
          </ViewportPortal>
        )}
      </ReactFlow>
      {openOverlay != null && <OverlayCard overlay={openOverlay} onClose={() => setOpenOverlayId(null)} />}
      {routing != null && (
        <div className="drawing-lens-key" data-testid="routing-lens-key">
          {table != null && (
            <label className="drawing-lens-key__table">
              Table{' '}
              <select value={table.current} onChange={(e) => table.onPick(e.target.value)} data-testid="routing-table-picker">
                {table.names.map((n) => (
                  <option key={n} value={n}>
                    {n === 'default' ? 'default' : `VRF ${n}`}
                  </option>
                ))}
              </select>
              <span className="drawing-lens-key__note">a trace from a device walks in it</span>
            </label>
          )}
          <span>Ink: routed · Dashed: switched · Boxes never move</span>
        </div>
      )}
      {links != null && (
        <div className="drawing-lens-key drawing-links-key" data-testid="links-lens-key">
          <span className="drawing-links-key__head">Networks</span>
          {links.key.length === 0 ? (
            <span className="drawing-lens-key__note">No VLANs in this design yet</span>
          ) : (
            <ul className="drawing-links-key__rows">
              {links.key.map((r) => (
                <li key={r.vlanId} data-testid="links-key-row">
                  <svg width="22" height="8" aria-hidden="true">
                    <line x1="0" y1="4" x2="22" y2="4" stroke={`var(--vlan-${r.slot})`} strokeWidth="2.4" />
                  </svg>
                  <span className="drawing-links-key__id">VLAN {r.vlanId}</span>
                  {r.name != null && <span className="drawing-links-key__name">{r.name}</span>}
                  {r.cidr != null && <span className="drawing-links-key__cidr">{r.cidr}</span>}
                </li>
              ))}
            </ul>
          )}
          <span className="drawing-links-key__legend">
            <svg width="22" height="8" aria-hidden="true">
              <line x1="0" y1="4" x2="22" y2="4" stroke="var(--ink)" strokeWidth="3.2" />
              <line x1="0" y1="4" x2="22" y2="4" stroke="var(--page)" strokeWidth="1.3" />
            </svg>
            Trunk · thicker is faster · boxes never move
          </span>
        </div>
      )}
      <CanvasTools wheel={wheel} onWheel={setWheel} />
      <CollabLayer />
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
