import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent, ReactNode } from 'react';
import {
  Background,
  ConnectionMode,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type ConnectionLineComponentProps,
  type Edge,
  type FinalConnectionState,
  type IsValidConnection,
  type NodeMouseHandler,
  type OnConnectEnd,
  type OnConnectStart,
  type OnNodeDrag,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import '../../styles/drawing.css';

import { compatible } from '../../document/compat';
import { CablesViewControl } from './CablesViewControl';
import { filterCablesByVisibility, loadCableVisibility, saveCableVisibility, type CableVisibility } from './cableVisibility';
import type { CableKind, CableView, ChassisView, ClosetView, DrawingActions, RackView, RowView, Selection, Sheath } from './contract';
import { PORT_CLICK_DRAG_THRESHOLD_PX } from './connectThreshold';
import { decodePaletteDrag, PALETTE_DRAG_MIME } from './dnd';
import {
  CAMERA_STOPS,
  MAX_ZOOM,
  MIN_ZOOM,
  RACK_HEADER_PX,
  RACK_INNER_PX,
  U_PX,
  cableSagPath,
  cameraStopAt,
  overlapsRack,
  rackAtPoint,
  snapDropToU,
  zoomAboutPaneCentre,
} from './geometry';
import { ChassisNode, INLET_ANCHOR_HANDLE_ID, type ChassisNodeData, type ChassisNodeType } from './ChassisNode';
import { BundleEdge, type BundleEdgeData, type BundleEdgeType } from './BundleEdge';
import { CableEdge, type CableEdgeData, type CableEdgeType } from './CableEdge';
import { ColourPicker } from './ColourPicker';
import { StableRef } from './idCache';
import { createLiveStore, EMPTY_STRING_SET, LiveStoreProvider, useLive, type LiveStore } from './liveStore';
import { portSheathEqual } from './nodeEquality';
import { RACK_NODE_WIDTH, RackNode, rackNodeHeight, type RackNodeType } from './RackNode';
import { PortalTrayNode, type PortalTrayNodeType } from './PortalTrayNode';
import { RowLabelNode, type RowLabelNodeType } from './RowLabelNode';
import { ShelfPlate, type ShelfPlateNodeType } from './ShelfPlate';
import { SurfaceNode, type SurfaceNodeType } from './SurfaceNode';
import { chassisNodeId, parseNodeId, rackNodeId, surfaceNodeId, trayNodeId } from './nodeId';
import { findAnyPort, findFixture, findOccupant, locatePort, resolvePlaceNode } from './lookup';
import { liveTargetPortIds } from './liveTargets';
import { groupPortals, type PortalGroup } from './portals';
import { sheathsFor } from './sheath';
import { groupBundles } from './bundles';
import { litPathFor } from './paths';
import { powerLeadHandle, type Facing } from './elevation';
import {
  layoutRow,
  layoutSurfaces,
  mirroredRackX,
  RACK_GAP_PX,
  ROW_GAP_PX,
  rowBandY as rowBandYOf,
  rowKey,
  type RowLayout,
} from './rows';
import { buildDrawingNodes, createDrawingNodeCaches } from './buildDrawingNodes';

const NODE_TYPES = {
  rack: RackNode,
  chassis: ChassisNode,
  tray: PortalTrayNode,
  rowLabel: RowLabelNode,
  surface: SurfaceNode,
  shelf: ShelfPlate,
};
const EDGE_TYPES = { cable: CableEdge, bundle: BundleEdge };

/** ADR-0050 §2: "a rack with no row is its own row." `view.rows` is the
 * document builder's own logic (`document/view.ts`'s session note) and may
 * not be populated yet; this falls back to grouping `view.racks` by each
 * rack's own `row` field (preserving arrival order as the bay order) so the
 * drawing still has *something* to lay out by — every rack still draws,
 * simply one to a row until the document side fills `row`/`bay` in. */
function rowsOf(view: Pick<ClosetView, 'rows' | 'racks'>): RowView[] {
  if (view.rows.length > 0) return view.rows;
  const byRow = new Map<string, RackView[]>();
  const order: string[] = [];
  for (const rack of view.racks) {
    const key = rack.row ?? `__no-row-${rack.id}__`;
    if (!byRow.has(key)) {
      byRow.set(key, []);
      order.push(key);
    }
    byRow.get(key)!.push(rack);
  }
  return order.map((key) => ({ label: byRow.get(key)![0]!.row, racks: byRow.get(key)! }));
}

/** The flow-space top of the `rowIndex`-th row's band — `rows.ts`'s own
 * `rowBandY`, fixed to this drawing's own rack height and row gap. */
function rowBandY(rowLayouts: readonly RowLayout[], rowIndex: number): number {
  return rowBandYOf(rowLayouts, rowIndex, rackNodeHeight, ROW_GAP_PX);
}

/** The live drooping lead while a drag-to-connect is in progress — UI-SPEC
 * "Motion" #1: "Cable droops as you pull it," and "Cables": "you see the
 * slack before you commit." Undecided sheath yet (the picker has not
 * opened), so this draws in `--muted` ink rather than any real sheath —
 * `Patching.dc.html`'s own reference board draws the in-hand lead the same
 * plain grey. */
function ConnectionLine({ fromX, fromY, toX, toY }: ConnectionLineComponentProps) {
  const d = cableSagPath(fromX, fromY, toX, toY, 'copper');
  return (
    <path d={d} fill="none" stroke="var(--muted)" strokeWidth={2.4} strokeLinecap="round" className="drawing-cable__live" />
  );
}

/** How long the shake plays before the rejected drop's mark clears —
 * UI-SPEC "Motion" #2: "target shakes once sideways, lead springs back."
 * Matches `drawing.css`'s `--drawing-shake-ms`. */
const SHAKE_MS = 220;

/** This session's brief item 2 — how long a wheel tick (or a pan) must go
 * quiet before its viewport is committed to React state, rather than every
 * single tick. */
const WHEEL_SETTLE_MS = 100;

/** This session's brief item 5, the "Show on rack" fix — whether the
 * mount-time "fit every rack" camera move (the `allRacksPositioned` effect,
 * below) should run. `RacksPlace.tsx`'s own `initialFocus` effect lands a
 * chosen chassis at the faceplate stop through a SEPARATE, edge-triggered
 * `rf.setCenter` (the `configDrawerOpen` effect, further down, the same one
 * Motion #10's shelf-occupant open already uses) — not wrapped in a
 * `requestAnimationFrame`, unlike the generic fit below. Before this fix the
 * two raced: the generic fit's own `requestAnimationFrame` callback,
 * scheduled during the SAME render that first saw the pending focus, could
 * still fire on the next paint — after the focus's own `setCenter` already
 * ran — and silently drag the camera back to "every rack fitted," undoing
 * the very selection "Show on rack" asked for.
 *
 * `isFirstRun` is true only for the very first render at which
 * `allRacksPositioned` holds (a `useRef` flag the caller flips once, never
 * back) — every later rack-set change still fits exactly as before,
 * regardless of what happens to be selected then; only the initial race is
 * guarded. A `selected` naming a chassis IS a pending focus (`RacksPlace.tsx`'s
 * `useState(initialFocus ?? null)` sets it synchronously, before this
 * component's own first render, whenever the design was already loaded) —
 * the one case this defers to. */
export function shouldFitOnMount(isFirstRun: boolean, selected: Selection | null): boolean {
  return !(isFirstRun && selected?.kind === 'chassis');
}

/** Fit every rack: used on mount, landing at the rack stop. */
function rackFitViewOptions(racks: readonly { id: string }[]) {
  return {
    nodes: racks.map((r) => ({ id: rackNodeId(r.id) })),
    padding: 0.1,
    maxZoom: CAMERA_STOPS.rack / 100,
  };
}

/** Fit every rack AND surface: the bar's own "Fit to view" — the whole
 * closet. `minZoom` goes below `MIN_ZOOM` to match the bar's own +/- floor. */
function closetFitViewOptions(racks: readonly { id: string }[], surfaces: readonly { id: string }[]) {
  return {
    nodes: [...racks.map((r) => ({ id: rackNodeId(r.id) })), ...surfaces.map((s) => ({ id: surfaceNodeId(s.id) }))],
    padding: 0.1,
    minZoom: 0.1,
    maxZoom: CAMERA_STOPS.rack / 100,
  };
}

export interface DrawingProps extends DrawingActions {
  view: ClosetView;
  selected: Selection | null;
  /** The bar's zoom percentage, e.g. `100` — `Shell`'s own `zoom` prop
   * convention. Kept in agreement with React Flow's viewport: this
   * component is the one place that converts between the two. */
  zoom: number;
  onZoomChange: (zoom: number) => void;
  /** Bump to fit every rack into view (a counter, so a repeat press fires). */
  fitRequest?: number;
  /** ADR-0052 §5's view-only rendering: `capability !== 'read'`
   * (`RacksPlace.tsx`'s own computation, the one place capability is read).
   * `false` disables React Flow's own `nodesDraggable`/`nodesConnectable`
   * (below) — a reader neither moves a chassis or rack nor starts a cable —
   * and this component refuses a palette drop itself rather than trust the
   * caller never to raise `onPlace` (`handleDrop`, below): a reader that
   * somehow still fires a native drag-and-drop event gets no placement. */
  canDraw: boolean;
  /** ADR-0052 §1/§4, this session's brief item 2 — "the drawer opens
   * beneath the faceplate." This component knows the camera stop and the
   * selection; it does not know the `Document`, the Mirror or the save path
   * the drawer itself needs (`contract.ts`'s own file header: this drawing
   * never imports `document/` for anything but the view types) — so the
   * caller (`racks/RacksPlace.tsx`) supplies the drawer's content as a
   * function of the selected chassis, called only once that chassis is
   * selected AND the camera reads as the faceplate stop, and the caller
   * decides whether that content is the real `ConfigDrawer` or `null`
   * (ADR-0052 §5's "canDraw or a capture exists" gate lives with the
   * caller, which is the one place that knows whether a capture exists). */
  renderConfigDrawer?: (chassis: ChassisView) => ReactNode;
  /** ADR-0051 "Inside a box" / this session's brief item 3 — the stop
   * beyond faceplate. Same shape as `renderConfigDrawer` above, called once
   * the camera reads as the `'inside'` stop for the selected chassis. */
  renderInsideStop?: (chassis: ChassisView) => ReactNode;
  /** ADR-0052 §1, this session's brief item 2 — "click a line and the port
   * it built lights, tagged with which line built it." The caller
   * (`racks/RacksPlace.tsx`) tracks the drawer's own hover/select state and
   * resolves it to a port label on the selected chassis; this component
   * resolves that label to a port id on the currently-selected chassis
   * (`ChassisView.ports`) and lights it through `ChassisNode.tsx`'s
   * existing `data-port-id` attribute (already emitted for every port and
   * inlet glyph) — a CSS class toggled on the matching element, the same
   * "reuse what is already there" reading `litCableId` above gives the
   * rail hexagon's own hover. `null`/absent lights nothing. */
  litPortLabel?: string | null;
}

type AnyRackNode = RackNodeType;
type AnyChassisNode = ChassisNodeType;
type AnyTrayNode = PortalTrayNodeType;
type FlowNode = AnyRackNode | AnyChassisNode | AnyTrayNode | RowLabelNodeType | SurfaceNodeType | ShelfPlateNodeType;

type RackPositions = Record<string, { x: number; y: number }>;
type DropPreview = Record<string, { fromU: number; toU: number; valid: boolean }>;

/** A drop the picker has not yet confirmed — UI-SPEC "Drag-to-connect":
 * nothing is recorded until the picker's own accept. `screenX`/`screenY`
 * are screen pixels (`useReactFlow`'s `flowToScreenPosition`), not flow
 * space — the picker is a fixed-size overlay, never zoomed with the
 * canvas. */
interface PendingConnect {
  fromPortId: string;
  toPortId: string;
  kind: CableKind;
  screenX: number;
  screenY: number;
}

/** One sheath remembered per cable kind, for the session — UI-SPEC
 * "Drag-to-connect": "the last-used one for that kind preselected." Never
 * persisted past the session (not a document fact, the same rule
 * `RACK_GAP_PX`'s own session-only layout follows). */
type LastSheathByKind = Partial<Record<CableKind, Sheath>>;

interface LiveLitPathProps {
  view: ClosetView;
  portalGroups: readonly PortalGroup[];
  selected: Selection | null;
  liveStore: LiveStore;
}

/** This session's brief item 3 — a cable's own hover must not re-render
 * `Drawing.tsx`. Subscribed to `liveStore.ts`'s own `hoveredCableId`
 * (written there directly by a cable's or a rail hexagon's hover, never
 * through `Drawing.tsx`'s state), this is the one place that recomputes the
 * lit path and writes it back — so only this component re-renders on a
 * hover, never the node-building loop below it. */
function LiveLitPath({ view, portalGroups, selected, liveStore }: LiveLitPathProps) {
  const hoveredCableId = useLive((s) => s.hoveredCableId);
  const litCableId = selected?.kind === 'cable' ? selected.id : hoveredCableId;
  const litPath = useMemo(() => (litCableId ? litPathFor(view, litCableId, portalGroups) : null), [view, litCableId, portalGroups]);
  const litCableIdSet = useMemo(() => new Set(litPath?.cableIds ?? []), [litPath]);
  const litTrayKeySet = useMemo(() => new Set(litPath?.trayKeys ?? []), [litPath]);
  useLayoutEffect(() => {
    liveStore.setState({ litCableId, litCableIdSet, litTrayKeySet });
  }, [liveStore, litCableId, litCableIdSet, litTrayKeySet]);
  return null;
}

function DrawingInner({
  view,
  selected,
  zoom,
  onZoomChange,
  fitRequest,
  onPlace,
  onMove,
  onSelect,
  onConnect,
  onDisconnect,
  onRemoveDevice,
  onUndo,
  onRedo,
  canDraw,
  renderConfigDrawer,
  renderInsideStop,
  litPortLabel,
}: DrawingProps) {
  const rf = useReactFlow<FlowNode>();

  // Hover, selection, the lit path, drag state and zoom-derived styling
  // live here, not on any node's own `data` — see `liveStore.ts`'s own file
  // header. One store per mounted drawing, provided to every node this
  // drawing draws via `LiveStoreProvider` below.
  const [liveStore] = useState(() => createLiveStore());
  // Each node object (and its `data`) keeps its reference unless the
  // device, rack, shelf, surface or tray it draws actually changed —
  // `buildDrawingNodes.ts`'s own caches, decided against field by field
  // (`nodeEquality.ts`), never by stringifying the whole thing. One
  // instance per mounted drawing, like `liveStore` above.
  const drawingNodeCachesRef = useRef(createDrawingNodeCaches());
  // `portSheath` (below) is a `Map`, rebuilt with a fresh reference on ANY
  // document edit (`view.cables` is rebuilt fresh by `viewOf` even when the
  // edit touched nothing about a cable) — handed back its previous
  // reference when its entries are unchanged, so that reference churn alone
  // never invalidates every chassis, shelf and surface node on ANY edit.
  const portSheathRef = useRef(new StableRef<ReadonlyMap<string, Sheath>>());

  const [rackPositions, setRackPositions] = useState<RackPositions>({});
  // s6f #3: racks a person has dragged by hand — the row-flip layout effect
  // (below) never snaps one of these back to a freshly computed bay slot;
  // it mirrors whatever position it already has instead. Session-only, like
  // `rackPositions` itself (never cleared once set — a rack stays "one a
  // person placed" for the rest of the session, the same way `rackPositions`
  // itself is never reset to "derived" once a person has touched it).
  const [draggedRackIds, setDraggedRackIds] = useState<ReadonlySet<string>>(() => new Set());
  // The previous render's per-row elevation, keyed by `rows.ts`'s own
  // `rowKey` — read (never written outside the layout effect) so that
  // effect can tell which row, if any, is the one that JUST flipped, rather
  // than re-snapping every row's racks whenever `rowLayouts` changes for
  // any reason (a document update, a different row's own flip).
  const prevRowElevationRef = useRef<Record<string, Facing>>({});
  // With a controlled `nodes` array and no `onNodesChange`, React Flow never
  // moves a dragged node's own rendered position by itself — only this
  // override does, echoing `onNodeDrag`'s own live position back into
  // exactly the one chassis being dragged, so every other node's reference
  // (and cache entry) is untouched.
  const [dragOverride, setDragOverride] = useState<{ id: string; position: { x: number; y: number } } | null>(null);
  const [dropPreview, setDropPreview] = useState<DropPreview>({});
  const [shakingId, setShakingId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: Math.max(zoom, 1) / 100 });
  const shakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `FinalConnectionState.to` (below) is already screen space, but relative
  // to the React Flow container rather than the page — this is what turns
  // it into the page coordinates the colour picker's `position: fixed`
  // overlay actually needs.
  const containerRef = useRef<HTMLDivElement>(null);

  // Drag-to-connect (UI-SPEC "Cables", "Drag-to-connect") and cable
  // selection/hover (UI-SPEC "Selection").
  const [dragFromPortId, setDragFromPortId] = useState<string | null>(null);
  const [pendingConnect, setPendingConnect] = useState<PendingConnect | null>(null);
  const [lastSheathByKind, setLastSheathByKind] = useState<LastSheathByKind>({});
  // This session's brief item 3 — writes straight to `liveStore.ts` rather
  // than to component state, so hovering a cable or a rail hexagon never
  // re-renders this component. Permanently stable, like the `useState`
  // setter it replaces.
  const handleHoverCable = useCallback((cableId: string | null) => liveStore.setState({ hoveredCableId: cableId }), [liveStore]);
  // This session's brief item 1 — the cables view control: "the choice is
  // per browser (localStorage, wrapped in try/catch) and never saved to the
  // document." Read once, lazily, on mount (`useState`'s own initialiser
  // form) rather than in an effect, so the very first render already draws
  // whatever this browser last chose instead of flashing "all" for a frame.
  const [cableVisibility, setCableVisibilityState] = useState<CableVisibility>(() => loadCableVisibility());
  const handleCableVisibilityChange = useCallback((next: CableVisibility) => {
    setCableVisibilityState(next);
    saveCableVisibility(next);
  }, []);
  // This session's brief items 3/4 — the selected cable's two ports (a
  // hairline ring) and the port a refused cable drop landed on (a shake),
  // both toggled as a DOM class on the SAME `data-port-id` element
  // `litPortId`'s own effect below already targets, rather than threading a
  // new prop through `ChassisNode`/`ShelfPlate`/`SurfaceNode`'s three
  // separate data shapes for one hairline or one 220ms animation.
  const [shakingPortId, setShakingPortId] = useState<string | null>(null);
  const portShakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerPortShake = useCallback((portId: string) => {
    if (portShakeTimer.current != null) clearTimeout(portShakeTimer.current);
    setShakingPortId(portId);
    portShakeTimer.current = setTimeout(() => setShakingPortId(null), SHAKE_MS);
  }, []);
  useEffect(
    () => () => {
      if (portShakeTimer.current != null) clearTimeout(portShakeTimer.current);
    },
    [],
  );
  // ADR-0050 §1: "a flip at rack scale" — session-only, per rack, like
  // `rackPositions` above; not a document fact (`RACK_GAP_PX`'s own rule).
  // The rack stop's own control (`RackNode.tsx`'s header). Takes precedence
  // over the row's own flip (below) for whichever rack it names — an
  // explicit rack-stop choice, not something a row flip should fight to
  // override.
  const [rackFacing, setRackFacing] = useState<Record<string, Facing>>({});
  // ADR-0050 §2: "per row at the closet stop" — keyed by `rows.ts`'s own
  // `rowKey`, since an unlabelled row has no other stable identity.
  const [rowFacing, setRowFacing] = useState<Record<string, Facing>>({});
  // UI-SPEC "Keeping it readable at forty cables" #2: "the band opens into
  // its members... then folds back on leave" — the one bundle currently
  // fanned open, or `null` when none is.
  const [fannedBundleKey, setFannedBundleKey] = useState<string | null>(null);

  // ADR-0050 §2: the closet stop's own layout unit. `rowViews` is `view.rows`
  // (or `rowsOf`'s fallback grouping when the document builder has not
  // populated it yet); `rowLayouts` resolves each row's own bay order
  // against its current flip — front keeps `view.rows`' own "bay ascending
  // as seen from the front" order, rear reverses it ("you have walked
  // round").
  const rowViews = useMemo(() => rowsOf(view), [view]);
  const rowLayouts = useMemo(
    () => rowViews.map((row, i) => layoutRow(row, rowFacing[rowKey(row, i)] ?? 'front')),
    [rowViews, rowFacing],
  );

  const livePortIds = useMemo(
    () => (dragFromPortId ? liveTargetPortIds(view, dragFromPortId) : null),
    [view, dragFromPortId],
  );

  // This session's brief item 1 — "hiding a kind removes those cables and
  // bundles from the drawing and their fill from ports, never a box." The
  // one filtered list everything below draws from; the boxes themselves
  // (chassis, shelf, surface, portal tray) are built from the real `view`,
  // never this one, so a hidden kind never removes anything but a cable, a
  // bundle and a port's own sheath fill.
  const visibleCables = useMemo(
    () => filterCablesByVisibility(view.cables ?? [], cableVisibility),
    [view.cables, cableVisibility],
  );

  // UI-SPEC "Cables": "the port a cable fills takes the sheath colour" —
  // built once per view change rather than have every `ChassisNode` search
  // the whole cable list for its own ports.
  const freshPortSheath = useMemo(() => {
    const map = new Map<string, Sheath>();
    for (const cable of visibleCables) {
      if (cable.sheath == null) continue;
      for (const end of cable.ends) {
        if ('portId' in end) map.set(end.portId, cable.sheath);
      }
    }
    return map;
  }, [visibleCables]);
  // Handed back its previous reference when nothing in it actually changed
  // — used directly as a node cache dependency below, so an edit touching
  // no cable's colour never invalidates every chassis, shelf and surface.
  const portSheath = portSheathRef.current.get('portSheath', freshPortSheath, portSheathEqual);
  portSheathRef.current.sweep();

  // ADR-0050 §2: "the closet stop arranges racks by row, bays left to right
  // as seen from the front." Every rack's position is derived from
  // `rowLayouts` — its row's band (top to bottom, `rowBandY`) and its bay
  // index within that row's *current* order (left to right, already
  // reversed for a row flipped to rear by `layoutRow` above). Recomputed
  // whenever `rowLayouts` itself changes — on mount, when the document's own
  // rows/racks change, and whenever any row's flip toggles — which is what
  // turns a row flip into "racks move to their mirrored places... nothing
  // remounts" (ADR-0050 §2): the same rack ids keep their React Flow node
  // identity, only the position each one is given changes, and
  // `drawing.css`'s own node transition is what makes that read as a slide
  // rather than a jump. A rack a person has freely dragged keeps that
  // position across renders where `rowLayouts` itself does not change (nothing
  // here runs merely because `rackPositions` changed); it is
  // only re-derived, like every other rack's, the next time a row's own flip
  // (or the document's row/bay data) actually changes.
  //
  // s6f #3: "only racks in the flipped row move, and a rack the person
  // dragged in that row moves by the mirror of its dragged offset, not to a
  // fresh slot." Two refinements on top of the paragraph above, which was
  // previously only true for a rack nobody had dragged: a row whose own
  // elevation did not just change (`prevRowElevationRef`, above) leaves
  // every rack in it untouched even though this effect is re-running (some
  // OTHER row's flip is what changed `rowLayouts`); and within a row whose
  // elevation did just change, a dragged rack is reflected across that
  // row's own width (`rows.ts`'s own `mirroredRackX`, its own doc — the
  // same position the ordinary `want` formula below would land a rack
  // sitting exactly on a bay slot on, generalised to whatever off-slot x a
  // drag left it at) rather than snapped to the bay index's fresh slot.
  useEffect(() => {
    const prevElevation = prevRowElevationRef.current;
    const nextElevation: Record<string, Facing> = {};
    setRackPositions((prev) => {
      const next = { ...prev };
      let changed = false;
      rowLayouts.forEach((layout, rowIndex) => {
        const key = rowKey(rowViews[rowIndex]!, rowIndex);
        nextElevation[key] = layout.elevation;
        const y = rowBandY(rowLayouts, rowIndex);
        const rowJustFlipped = (prevElevation[key] ?? 'front') !== layout.elevation;
        layout.racks.forEach((rack, bayIndex) => {
          if (draggedRackIds.has(rack.id)) {
            if (!rowJustFlipped) return; // a dragged rack outside the row that just flipped: untouched
            const have = prev[rack.id];
            if (have == null) return; // nothing placed yet to mirror
            const mirroredX = mirroredRackX(have.x, layout.racks.length, RACK_NODE_WIDTH, RACK_GAP_PX);
            if (have.x !== mirroredX) {
              next[rack.id] = { x: mirroredX, y: have.y };
              changed = true;
            }
            return;
          }
          const want = { x: bayIndex * (RACK_NODE_WIDTH + RACK_GAP_PX), y };
          const have = prev[rack.id];
          if (have == null || have.x !== want.x || have.y !== want.y) {
            next[rack.id] = want;
            changed = true;
          }
        });
      });
      return changed ? next : prev;
    });
    prevRowElevationRef.current = nextElevation;
    // `draggedRackIds` deliberately not a dependency, the same reasoning the
    // paragraph above already gives `rackPositions`: a drag
    // itself must not re-run this effect, only the next actual row-flip or
    // document change reads whatever `draggedRackIds` holds by then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowLayouts]);

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

  // `handleViewportChange` (below) applies a wheel tick's own zoom locally
  // the same instant it reports the rounded percentage upward; that
  // report's own echo can arrive back here after a LATER tick has already
  // moved `viewport` on. `pendingEchoRef` is the most recent percentage
  // this component itself reported and has not yet seen come back — when
  // the incoming `zoom` matches it exactly, it is skipped rather than
  // reapplied, so it never fights a wheel still turning.
  const pendingEchoRef = useRef<number | null>(null);
  // This session's brief item 1 — set while a `setCenter`/`fitView` move is
  // in flight. React Flow drives that move's own frames straight into its
  // internal store; echoing each of them back into this controlled
  // `viewport` prop hands it a fresh "jump here," which cancels the move
  // after its first frame. `handleViewportChange` skips the echo entirely
  // until `runProgrammaticMove`'s own `.then` clears this and commits once.
  const programmaticMoveRef = useRef(false);
  const liveViewportRef = useRef(viewport);
  const wheelSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commitViewport = useCallback(
    (vp: Viewport) => {
      setViewport(vp);
      const pct = Math.round(vp.zoom * 100);
      if (pct !== zoom) {
        pendingEchoRef.current = pct;
        onZoomChange(pct);
      }
    },
    [zoom, onZoomChange],
  );

  const runProgrammaticMove = useCallback(
    (move: () => Promise<boolean>) => {
      programmaticMoveRef.current = true;
      void move().then(() => {
        programmaticMoveRef.current = false;
        commitViewport(rf.getViewport());
      });
    },
    [commitViewport, rf],
  );

  // This session's brief item 5: guards the race `shouldFitOnMount` above
  // documents — flips true on the first qualifying run and stays there, so
  // only that first run can ever be skipped.
  const hasFitOnceRef = useRef(false);
  useEffect(() => {
    if (!allRacksPositioned || view.racks.length === 0) return;
    const isFirstRun = !hasFitOnceRef.current;
    hasFitOnceRef.current = true;
    if (!shouldFitOnMount(isFirstRun, selected)) return; // a pending focus wins outright, once
    const raf = requestAnimationFrame(() => {
      runProgrammaticMove(() => rf.fitView(rackFitViewOptions(view.racks)));
    });
    return () => cancelAnimationFrame(raf);
    // `view.racks` itself is deliberately not a dependency: `rackIdsKey` is
    // its content identity (which racks exist), and that is the only
    // change this effect should react to. The array's own object identity
    // is not guaranteed stable across a caller's re-renders (nothing
    // requires the caller to memoise it), and re-fitting on every render
    // would fight a person's own scroll-zoom. `selected` is deliberately not
    // a dependency either — reading it fresh from the closure is exactly
    // right for `isFirstRun`'s one-time check (this effect's dependencies
    // are unrelated to selection changes, and adding `selected` here would
    // re-run the generic fit every time someone merely clicks something).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rackIdsKey, allRacksPositioned, rf]);

  useEffect(() => {
    if (programmaticMoveRef.current) return; // a move already owns the echo; let it finish and commit once
    if (pendingEchoRef.current === zoom) {
      pendingEchoRef.current = null;
      return;
    }
    setViewport((v) => {
      if (Math.round(v.zoom * 100) === zoom) return v;
      const nextZoom = zoom / 100;
      const pane = containerRef.current;
      if (pane == null) return { ...v, zoom: nextZoom };
      return zoomAboutPaneCentre(v, nextZoom, pane.clientWidth, pane.clientHeight);
    });
  }, [zoom]);

  // The percentage button's fit; never fires on the first render. Frames
  // every rack and every surface — the whole closet, not just its racks.
  const prevFitRequestRef = useRef(fitRequest);
  useEffect(() => {
    if (fitRequest == null || fitRequest === prevFitRequestRef.current) return;
    prevFitRequestRef.current = fitRequest;
    runProgrammaticMove(() => rf.fitView(closetFitViewOptions(view.racks, view.surfaces ?? [])));
  }, [fitRequest, rf, view.racks, view.surfaces, runProgrammaticMove]);

  // This session's brief item 2 — a wheel tick, pinch or drag calls this
  // every frame, but `cameraStop` and the `--zoom`/`--zoom-pct` styling only
  // need the answer once it settles: this commits into React state right
  // away when the stop it reads as actually changes (every other render in
  // this component depends on that), and otherwise only once
  // `WHEEL_SETTLE_MS` passes with no further tick — never on every one of
  // them. A programmatic move in flight skips this entirely; it commits its
  // own landed viewport once itself (`runProgrammaticMove`, above).
  const handleViewportChange = useCallback(
    (vp: Viewport) => {
      liveViewportRef.current = vp;
      if (programmaticMoveRef.current) return;
      if (wheelSettleTimerRef.current != null) clearTimeout(wheelSettleTimerRef.current);
      const crossedStop = cameraStopAt(Math.round(vp.zoom * 100)) !== cameraStopAt(Math.round(viewport.zoom * 100));
      if (crossedStop) {
        commitViewport(vp);
        return;
      }
      wheelSettleTimerRef.current = setTimeout(() => commitViewport(liveViewportRef.current), WHEEL_SETTLE_MS);
    },
    [viewport.zoom, commitViewport],
  );

  useEffect(() => () => {
    if (wheelSettleTimerRef.current != null) clearTimeout(wheelSettleTimerRef.current);
  }, []);

  const triggerShake = useCallback((id: string) => {
    if (shakeTimer.current != null) clearTimeout(shakeTimer.current);
    setShakingId(id);
    shakeTimer.current = setTimeout(() => setShakingId(null), SHAKE_MS);
  }, []);

  useEffect(() => () => {
    if (shakeTimer.current != null) clearTimeout(shakeTimer.current);
  }, []);

  const zoomPercent = Math.round(viewport.zoom * 100);

  // UI-SPEC "Rear faces" / ADR-0050 §1: which stop this camera reads as
  // right now decides only whether the rack-stop's own flip control shows
  // (`showFlip`, below) and whether the row-label's own flip control shows
  // (closet stop only) — every stop now draws exactly one elevation per
  // rack, never both at once (the retired `faces.ts` faceplate-stop
  // stacking is gone with it, ADR-0050 §1).
  const cameraStop = cameraStopAt(zoomPercent);

  // Every rack's currently-drawn elevation: this rack's own flip
  // (`rackFacing`, the rack stop's control) when it has one, otherwise its
  // row's flip (`rowFacing`, the closet stop's control, defaulting to
  // front) — ADR-0050 §2: "per row at the closet stop and per rack at the
  // rack stop."
  const rowIndexByRackId = new Map<string, number>();
  rowViews.forEach((row, i) => row.racks.forEach((r) => rowIndexByRackId.set(r.id, i)));
  function elevationFor(rackId: string): Facing {
    const own = rackFacing[rackId];
    if (own) return own;
    const rowIndex = rowIndexByRackId.get(rackId);
    if (rowIndex == null) return 'front';
    return rowFacing[rowKey(rowViews[rowIndex]!, rowIndex)] ?? 'front';
  }

  // ADR-0052 §1/§4/§5, this session's brief items 2/3 — the config drawer
  // (item 2, `renderConfigDrawer`) and the inside stop (item 3,
  // `renderInsideStop`) both key off "a chassis is selected" and "the
  // camera reads at a particular stop," which this component already
  // tracks; only the chassis lookup is new. A rack-mounted `Chassis` only —
  // ADR-0052 §5's scope is "the inside stop for a Junos SRX," a rack device,
  // and the faceplate/inside stops themselves are rack-elevation concepts
  // (`CAMERA_STOPS`) that a shelf occupant or surface fixture does not
  // share a camera reading with.
  const selectedChassis: ChassisView | null =
    selected?.kind === 'chassis' ? (view.racks.flatMap((r) => r.chassis).find((c) => c.id === selected.id) ?? null) : null;
  // Motion #9: "A surface slides in from the right and out again; the
  // drawing beneath does not move" — content only, never whether to draw at
  // all: the caller decides that (`renderConfigDrawer`'s own doc, above) by
  // returning `null` when ADR-0052 §5's "canDraw or a capture exists" does
  // not hold, so this reads the same `!= null` check either way.
  const configDrawerContent: ReactNode =
    selectedChassis != null && cameraStop === 'faceplate' ? (renderConfigDrawer?.(selectedChassis) ?? null) : null;
  const insideStopContent: ReactNode =
    selectedChassis != null && cameraStop === 'inside' ? (renderInsideStop?.(selectedChassis) ?? null) : null;
  // UI-SPEC "Config": "Plate stays above, dimmed" — pushed to
  // `liveStore.ts` below so `ChassisNode.tsx` applies its own dim class.
  const dimmedChassisId = configDrawerContent != null ? (selectedChassis?.id ?? null) : null;

  // ADR-0052 §1, item 2 — resolves `litPortLabel` to a port id on the
  // selected chassis only: a line in one device's drawer has no business
  // lighting a same-labelled port on a different one.
  const litPortId =
    litPortLabel != null && selectedChassis != null ? (selectedChassis.ports.find((p) => p.label === litPortLabel)?.id ?? null) : null;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const lit = container.querySelectorAll('.drawing-port--lit');
    lit.forEach((el) => el.classList.remove('drawing-port--lit'));
    if (litPortId == null) return;
    const matches = container.querySelectorAll(`[data-port-id="${CSS.escape(litPortId)}"]`);
    matches.forEach((el) => el.classList.add('drawing-port--lit'));
  }, [litPortId]);

  // This session's brief item 3 — "while a cable is selected its two ports
  // carry a hairline ring on the plate." Both real ends of the SELECTED
  // cable, wherever each sits (a rack chassis, a shelf occupant, a surface
  // fixture) — `null`/empty whenever the selection is not a cable, or that
  // cable has no real port end at all (an outside-only or unterminated one).
  const ringedPortIds = useMemo(() => {
    if (selected?.kind !== 'cable') return null;
    const cable = (view.cables ?? []).find((c) => c.id === selected.id);
    if (cable == null) return null;
    const ids = cable.ends
      .filter((e): e is { portId: string; chassisId: string; rackId: string | null } => 'portId' in e)
      .map((e) => e.portId);
    return ids.length > 0 ? new Set(ids) : null;
  }, [selected, view.cables]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ringed = container.querySelectorAll('.drawing-port--ringed');
    ringed.forEach((el) => el.classList.remove('drawing-port--ringed'));
    if (ringedPortIds == null) return;
    ringedPortIds.forEach((portId) => {
      const matches = container.querySelectorAll(`[data-port-id="${CSS.escape(portId)}"]`);
      matches.forEach((el) => el.classList.add('drawing-port--ringed'));
    });
  }, [ringedPortIds]);

  // UI-SPEC "Motion" #2, this session's brief item 4 — "Wrong drop: target
  // shakes once sideways, lead springs back to your hand." The chassis-drop
  // shake above (`triggerShake`/`shakingId`, `RackNode.tsx`) already covers
  // a device dropped nowhere or overlapping; a cable dropped on an
  // incompatible or already-cabled port had no shake at all before this
  // session (`handleConnectEnd`'s own file header, further down, on why) —
  // this is that gap closed, triggered from there, drawn here.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || shakingPortId == null) return undefined;
    const matches = container.querySelectorAll(`[data-port-id="${CSS.escape(shakingPortId)}"]`);
    matches.forEach((el) => el.classList.add('drawing-port--shake'));
    return () => matches.forEach((el) => el.classList.remove('drawing-port--shake'));
  }, [shakingPortId]);

  // A plain forward to `onSelect`, closing over nothing node-specific — one
  // stable function every node shares, rather than a fresh closure built
  // per node per render.
  const handleSelectPort = useCallback((portId: string) => onSelect({ kind: 'port', id: portId }), [onSelect]);
  const handleSelectFixture = useCallback((fixtureId: string) => onSelect({ kind: 'fixture', id: fixtureId }), [onSelect]);

  // One stable function per node kind, shared instead of built fresh per
  // node per render.
  const onFlipRow = useCallback((key: string) => setRowFacing((prev) => ({ ...prev, [key]: prev[key] === 'rear' ? 'front' : 'rear' })), []);
  const onFlipRack = useCallback(
    (rackId: string) => setRackFacing((prev) => ({ ...prev, [rackId]: prev[rackId] === 'rear' ? 'front' : 'rear' })),
    [],
  );
  const onSelectShelf = useCallback((shelfId: string) => onSelect({ kind: 'shelf', id: shelfId }), [onSelect]);
  // Motion #10: "A box on a shelf opens at the faceplate stop by the same
  // camera as everything else" — one continuous `setCenter`, never a
  // second, independent jump.
  const onOpenShelfOccupant = useCallback(
    (occupantId: string, centreX: number, centreY: number) => {
      onSelect({ kind: 'occupant', id: occupantId });
      runProgrammaticMove(() => rf.setCenter(centreX, centreY, { zoom: CAMERA_STOPS.faceplate / 100, duration: 300 }));
    },
    [onSelect, runProgrammaticMove, rf],
  );

  // UI-SPEC "Portals": one tray node per (rack, side, far label) group —
  // `portals.ts` does the grouping; `buildDrawingNodes.ts` lays the
  // resulting boxes out above or below their rack.
  const portalGroups = useMemo(() => groupPortals(view), [view]);

  // ADR-0051 §1/§2, `design/places/renders/Surfaces.png`: the closet layout
  // places surfaces after the rows, walls to the right of their premises'
  // rows and the floor beneath. `rows.ts`'s own `layoutSurfaces` is pure pixel
  // arithmetic over the row block's own total footprint — never over which
  // order the racks within a row currently draw in — so a row's own flip
  // (`rowLayouts`, above) never moves a surface: "positions stable across
  // flips," `rows.ts`'s own file header on why.
  //
  // The row block's own width is the widest row's own rack count at the
  // rack layout's own pitch (`RACK_NODE_WIDTH + RACK_GAP_PX`, one gap
  // narrower than the count since there is no trailing gap); its height is
  // every row band stacked, `rowBandY`'s own sum carried one row past the
  // last. `panelHeightPx` — drawn at the height of a rack
  // (`design/places/renders/Surfaces.png`, ADR-0051 §1/§2) — reads the
  // TALLEST rack this closet actually holds (42U, this
  // drawing's own reference height per `geometry.ts`'s file header, when
  // there is none to read), so a wall lines up with whichever rack stands
  // tallest beside it rather than an arbitrary one.
  const rowsWidthPx = Math.max(
    0,
    ...rowLayouts.map((layout) => (layout.racks.length > 0 ? layout.racks.length * (RACK_NODE_WIDTH + RACK_GAP_PX) - RACK_GAP_PX : 0)),
  );
  const rowsHeightPx = rowBandY(rowLayouts, rowLayouts.length);
  const tallestRackHeightU = Math.max(42, ...view.racks.map((r) => r.heightU));
  const panelHeightPx = rackNodeHeight({ heightU: tallestRackHeightU });
  const surfacesLayout = useMemo(
    () => layoutSurfaces(view.surfaces ?? [], rowsWidthPx, rowsHeightPx, panelHeightPx, U_PX),
    [view.surfaces, rowsWidthPx, rowsHeightPx, panelHeightPx],
  );

  // This session's brief item 5 — every rack, chassis, shelf, surface and
  // tray node this closet draws, built by `buildDrawingNodes.ts`'s own pure
  // function so a vitest can exercise the same code and caches this
  // component calls, with no DOM at all.
  const { nodes, selectedChassisFlowCentre, selectedPortOwnerCentre } = buildDrawingNodes(
    {
      view,
      rowViews,
      rowLayouts,
      rackPositions,
      cameraStop,
      elevationFor,
      canDraw,
      portSheath,
      dragOverride,
      selectedChassisId: selectedChassis?.id ?? null,
      selected,
      handleSelectPort,
      handleSelectFixture,
      onFlipRow,
      onFlipRack,
      onSelectShelf,
      onOpenShelfOccupant,
      onHoverInlet: handleHoverCable,
      surfacesLayout,
      portalGroups,
    },
    drawingNodeCachesRef.current,
  );

  // UI-SPEC "Config": "Plate stays above, dimmed" — `drawing.css`'s
  // `.drawing-config-drawer` reserves the pane's own bottom
  // `DRAWER_HEIGHT_FRACTION` for the drawer; this keeps the selected
  // chassis inside the remaining top strip, centred in it, whenever the
  // drawer opens — an edge-triggered `setCenter`, fired once on the
  // transition into "a chassis is selected and the camera reads the
  // faceplate stop," never on every zoom tick while it stays there, so a
  // person's own subsequent pan or scroll is never fought mid-read. One
  // camera, glide and all — UI-SPEC "Motion" #10.
  const configDrawerOpen = configDrawerContent != null;
  useEffect(() => {
    if (!configDrawerOpen || selectedChassisFlowCentre == null) return;
    const paneHeight = containerRef.current?.clientHeight ?? 0;
    if (paneHeight === 0) return;
    const zoomLevel = CAMERA_STOPS.faceplate / 100;
    const DRAWER_HEIGHT_FRACTION = 0.46; // matches `drawing.css`'s own literal
    const plateScreenFraction = (1 - DRAWER_HEIGHT_FRACTION) / 2; // the visible strip's own midpoint
    const targetY = selectedChassisFlowCentre.y + (paneHeight * (0.5 - plateScreenFraction)) / zoomLevel;
    runProgrammaticMove(() => rf.setCenter(selectedChassisFlowCentre.x, targetY, { zoom: zoomLevel, duration: 300 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- edge-triggered
    // on purpose (see comment above): `selectedChassisFlowCentre` itself is
    // rebuilt fresh every render and would fire this on every pixel of a
    // person's own drag or scroll if it were a dependency.
  }, [configDrawerOpen, selectedChassis?.id, rf]);

  // This session's brief items 2/3 — "Go to far end"/"Go to end A/B" pans
  // the camera to the selected port's own owning box at the faceplate stop,
  // one camera (`buildDrawingNodes.ts` resolves which box that is).
  const selectedPortId = selected?.kind === 'port' ? selected.id : null;
  useEffect(() => {
    if (selectedPortId == null || selectedPortOwnerCentre == null) return;
    runProgrammaticMove(() => rf.setCenter(selectedPortOwnerCentre.x, selectedPortOwnerCentre.y, { zoom: CAMERA_STOPS.faceplate / 100, duration: 300 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- edge-triggered
    // on the selected port's own id alone, the same reasoning
    // `configDrawerOpen`'s own effect above already gives
    // `selectedChassisFlowCentre`: recomputed fresh every render, and
    // listing it here would fire this on every pixel of a person's own pan
    // or scroll once a port happens to be selected.
  }, [selectedPortId, rf]);

  // ADR-0050 §1: "in the rear elevation a power lead ends on the inlet on
  // the face; in the front elevation it ends on the rail hexagon as today."
  // `findAnyPort` tells a PSU inlet apart from an ordinary faceplate port;
  // `elevationFor` (above) is which elevation the inlet's own rack is
  // currently drawn in — the front elevation still routes to the rack's own
  // rail handle (`RackNode.tsx`'s `psu.id`-keyed `Handle`).
  //
  // s6f #1: the rear elevation does NOT always route to the inlet's own
  // handle (`ChassisNode.tsx`'s `InletGlyph`) — that handle only exists once
  // the inlet strip itself has mounted and been measured, which the
  // faceplate stop's own zoomed-in read is the only stop that reliably
  // shows in time. At the closet and rack stops it routes to the chassis's
  // stable `INLET_ANCHOR_HANDLE_ID` instead — "the plate's inlet-end edge
  // (the same side the strip sits on)" — always present whenever the
  // chassis itself draws in the rear elevation, never gated on the strip's
  // own conditional mount.
  function resolveEnd(end: { portId: string; chassisId: string; rackId: string | null }): { nodeId: string; handleId: string } | null {
    const found = findAnyPort(view, end.portId);
    if (found) {
      if (found.isPsuInlet) {
        const via = powerLeadHandle(elevationFor(found.rack.id), cameraStop);
        if (via === 'rail') return { nodeId: rackNodeId(found.rack.id), handleId: end.portId };
        if (via === 'inlet') return { nodeId: chassisNodeId(found.chassis.id), handleId: end.portId };
        return { nodeId: chassisNodeId(found.chassis.id), handleId: INLET_ANCHOR_HANDLE_ID };
      }
      return { nodeId: chassisNodeId(end.chassisId), handleId: end.portId };
    }
    // ADR-0051 §1/§2: a `CableEnd` this drawing does not carry a rack
    // chassis for — a shelf occupant's own port or a surface fixture's —
    // resolved by `lookup.ts`'s own `resolvePlaceNode`, pure and shared with
    // its own tests: a shelf occupant's port routes to its shelf's one node
    // (`shelfNodeId`, now mounted above), a fixture's to its surface's one
    // node (`surfaceNodeId`), however deep it nests under a board — under
    // the SAME port id `ShelfPlate.tsx`/`SurfaceNode.tsx` render a `Handle`
    // for, `SurfaceNode.tsx` always, `ShelfPlate.tsx`'s own compact row
    // (`shelf.css`'s `.drawing-shelf__compact-port-handle`) with an
    // invisible one where there is no room to show the glyph.
    return resolvePlaceNode(view, end.portId) ?? null;
  }

  function portLabel(portId: string): string {
    return locatePort(view, portId)?.port.label || portId;
  }

  // UI-SPEC "Keeping it readable at forty cables" #1: cables sharing both
  // ends (and the same lane/kind, `bundles.ts`'s own doc) draw as one band.
  // Built off `visibleCables` (this session's brief item 1) — a bundle with
  // every member hidden by the cables view control is a bundle nobody
  // should see either.
  const bundles = useMemo(() => groupBundles(visibleCables), [visibleCables]);

  function buildCableEdge(cable: CableView, portPairLabel?: string): CableEdgeType | null {
    const real = cable.ends.filter((e): e is { portId: string; chassisId: string; rackId: string | null } => 'portId' in e);
    const outside = cable.ends.find((e): e is { outside: true; label: string } => 'outside' in e && e.outside);

    let target: { nodeId: string; handleId: string } | null = null;
    if (real.length === 2) {
      target = resolveEnd(real[1]);
    } else if (outside) {
      const group = portalGroups.find((g) => g.cables.some((c) => c.cableId === cable.id));
      if (group) target = { nodeId: trayNodeId(group.key), handleId: 'tray' };
    }
    if (real.length === 0 || target == null) return null; // no real near end to draw from

    const source = resolveEnd(real[0]);
    if (source == null) return null;

    const edgeData: CableEdgeData = {
      cable,
      onSelect: (cableId: string) => onSelect({ kind: 'cable', id: cableId }),
      onHoverChange: handleHoverCable,
      portPairLabel,
    };
    return {
      id: cable.id,
      type: 'cable',
      source: source.nodeId,
      sourceHandle: source.handleId,
      target: target.nodeId,
      targetHandle: target.handleId,
      selectable: false, // selection is handled by CableEdge's own onClick, not React Flow's
      // Above a chassis box's own `zIndex: 10` (below) — `Main.dc.html`'s own
      // rack draws its cables as one SVG layer over the elevation, not
      // tucked behind a device row a short hop happens to pass under.
      zIndex: 11,
      data: edgeData,
    } satisfies CableEdgeType;
  }

  const edges: Edge[] = [];
  const bundledCableIds = new Set(bundles.filter((b) => b.members.length > 1).flatMap((b) => b.members.map((m) => m.id)));

  for (const bundle of bundles) {
    if (bundle.members.length === 1) continue; // a bundle of one is a plain cable, handled below
    const fanned = fannedBundleKey === bundle.key;
    const bundleData: BundleEdgeData = {
      bundle,
      fanned,
      onFan: setFannedBundleKey,
    };
    edges.push({
      id: `bundle:${bundle.key}`,
      type: 'bundle',
      source: chassisNodeId(bundle.chassisA),
      sourceHandle: '__bundle__',
      target: chassisNodeId(bundle.chassisB),
      targetHandle: '__bundle__',
      selectable: false,
      zIndex: 11,
      data: bundleData,
    } satisfies BundleEdgeType);

    if (fanned) {
      for (const member of bundle.members) {
        const real = member.ends.filter((e): e is { portId: string; chassisId: string; rackId: string | null } => 'portId' in e);
        const label = real.length === 2 ? `${portLabel(real[0].portId)} ↔ ${portLabel(real[1].portId)}` : undefined;
        const built = buildCableEdge(member, label);
        if (built) edges.push(built);
      }
    }
  }

  for (const cable of visibleCables) {
    if (bundledCableIds.has(cable.id)) continue; // drawn above, as the bundle's band and (when fanned) its members
    const built = buildCableEdge(cable);
    if (built) edges.push(built);
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

      setDragOverride({ id: node.id, position: node.position });

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
        // s6f #3: once a person has placed this rack by hand, the row-flip
        // layout effect (above) stops snapping it to a freshly computed bay
        // slot and mirrors its own position instead.
        setDraggedRackIds((prev) => (prev.has(parsed.id) ? prev : new Set(prev).add(parsed.id)));
        return;
      }

      const heightU = chassisHeightUFor(node as FlowNode);
      const centre = { x: node.position.x + RACK_INNER_PX / 2, y: node.position.y + (heightU * U_PX) / 2 };
      const rack = rackAtPoint<RackView>(view.racks, rackPositions, centre, RACK_NODE_WIDTH);

      setDropPreview({});
      setDragOverride(null);

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

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!canDraw) return; // ADR-0052 §5: a reader's palette drop is refused, not merely ignored on drop
      if (!event.dataTransfer.types.includes(PALETTE_DRAG_MIME)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    [canDraw],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!canDraw) return; // ADR-0052 §5: no placement for a reader, even if a drop event somehow reaches here
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
    [rf, view.racks, rackPositions, onPlace, triggerShake, canDraw],
  );

  // UI-SPEC "Drag-to-connect": "the lead droops live between the fixed
  // port and the pointer; only ports compatible with the origin stay
  // live... a port that already has a cable is never a target."
  const isValidConnection: IsValidConnection = useCallback(
    (edgeOrConnection) => {
      if (!canDraw) return false; // ADR-0052 §5: belt-and-braces alongside `nodesConnectable={canDraw}` above
      const fromId = edgeOrConnection.sourceHandle;
      const toId = edgeOrConnection.targetHandle;
      if (!fromId || !toId || fromId === toId) return false;
      // ADR-0051 §1: `locatePort`, not `findPort` — a live drag may start or
      // end on a shelf occupant's port or a surface fixture's own (both draw
      // real `Handle`s now, `SurfaceNode.tsx`), not only a rack chassis's.
      const from = locatePort(view, fromId);
      const to = locatePort(view, toId);
      if (!from || !to) return false;
      if ((from.port.cable ?? null) != null) return false;
      if ((to.port.cable ?? null) != null) return false;
      return compatible(from.port.connector, to.port.connector).ok;
    },
    [view, canDraw],
  );

  const handleConnectStart: OnConnectStart = useCallback((_event, params) => {
    setDragFromPortId(params.handleId ?? null);
  }, []);

  // UI-SPEC "Drag-to-connect": "drop on a live port opens the colour
  // picker... drop anywhere else, or Escape, cancels with nothing
  // recorded." A drop that lands on an incompatible or already-cabled port
  // is simply not `isValid` — `connectionState.isValid` reflects
  // `isValidConnection` above — so it falls through to the same "nothing
  // recorded" path as a drop on empty canvas.
  //
  // UI-SPEC "Motion" #2, this session's brief item 4 — "Wrong drop: target
  // shakes once sideways, lead springs back to your hand." Previously true
  // only for a chassis dropped nowhere or overlapping (`overlapsRack`'s own
  // shake below); a wrong CABLE drop had no shake at all. The lead itself
  // already "springs back" for free — `setDragFromPortId(null)` just below
  // is what stops the live droop drawing at all, and React Flow's own
  // connection-in-progress state unmounts the SAME instant, so nothing ever
  // lingers mid-air to animate back. The shake is the other half: only when
  // the drop actually landed on some OTHER real port (`toHandleId`) rather
  // than empty canvas, which refuses nothing in particular to shake.
  const handleConnectEnd: OnConnectEnd = useCallback(
    (_event, connectionState: FinalConnectionState) => {
      setDragFromPortId(null);
      const toHandleId = connectionState.toHandle?.id ?? null;
      if (!connectionState.isValid) {
        if (toHandleId != null) triggerPortShake(toHandleId);
        return;
      }
      const fromHandleId = connectionState.fromHandle?.id;
      if (!fromHandleId || !toHandleId) return;
      const from = locatePort(view, fromHandleId);
      const to = locatePort(view, toHandleId);
      if (!from || !to) return;
      const result = compatible(from.port.connector, to.port.connector);
      if (!result.ok) return;

      // `connectionState.to` is screen space already (`@xyflow/system`'s own
      // `onPointerUp`: a valid drop's `to` is `rendererPointToPoint`, the
      // same conversion `flowToScreenPosition` does), but relative to the
      // React Flow container's own top-left, not the page's — add the
      // container's own offset to get real page coordinates for the
      // picker's `position: fixed` overlay.
      const rect = containerRef.current?.getBoundingClientRect();
      setPendingConnect({
        fromPortId: fromHandleId,
        toPortId: toHandleId,
        kind: result.kind,
        screenX: (rect?.left ?? 0) + connectionState.to.x,
        screenY: (rect?.top ?? 0) + connectionState.to.y,
      });
    },
    [view, triggerPortShake],
  );

  const handlePickerConfirm = useCallback(
    (sheath: Sheath) => {
      if (!pendingConnect) return;
      setLastSheathByKind((prev) => ({ ...prev, [pendingConnect.kind]: sheath }));
      onConnect?.(pendingConnect.fromPortId, pendingConnect.toPortId, sheath);
      setPendingConnect(null);
    },
    [pendingConnect, onConnect],
  );

  const handlePickerCancel = useCallback(() => setPendingConnect(null), []);

  // UI-SPEC "Delete/Backspace on a selected cable calls onDisconnect after
  // nothing else" extends to a selected device: `'chassis'` is always a
  // real device; `'occupant'`/`'fixture'` also match a passive fixture
  // (out of scope), so those two are checked against the view first.
  // React Flow's delete handling stays off (`deleteKeyCode={null}` below)
  // for racks, which have no delete feature yet.
  //
  // ADR-0053 §1/§3, this session's brief item 2 — Ctrl Z / Ctrl Shift Z, at
  // this SAME listener (the brief's own words: "at the existing keydown
  // site"), ignored while focus sits in an input, textarea, select or any
  // `contenteditable` — the Trail's own comment box and the Notes editor's
  // own add box (`racks/Trail.tsx`, `drawing/Editor.tsx`) both hold real
  // text fields a browser's own Ctrl Z already has a meaning for, and this
  // canvas has no business stealing that keystroke out of a field someone
  // is typing into.
  useEffect(() => {
    function focusIsInAField(): boolean {
      const el = document.activeElement;
      if (el == null) return false;
      if (el instanceof HTMLElement && el.isContentEditable) return true;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    }

    function onKeyDown(event: KeyboardEvent) {
      if (!canDraw) return; // ADR-0052 §5: a reader deletes nothing, undoes nothing
      if ((event.key === 'z' || event.key === 'Z') && (event.ctrlKey || event.metaKey)) {
        if (focusIsInAField()) return;
        event.preventDefault();
        if (event.shiftKey) onRedo?.();
        else onUndo?.();
        return;
      }
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (selected?.kind === 'cable') {
        event.preventDefault();
        onDisconnect?.(selected.id);
        return;
      }
      if (selected?.kind === 'chassis') {
        event.preventDefault();
        onRemoveDevice?.(selected.id);
        return;
      }
      if (selected?.kind === 'occupant') {
        if (findOccupant(view, selected.id)?.occupant.kind !== 'chassis') return;
        event.preventDefault();
        onRemoveDevice?.(selected.id);
        return;
      }
      if (selected?.kind === 'fixture') {
        if (findFixture(view, selected.id)?.fixture.kind !== 'chassis') return;
        event.preventDefault();
        onRemoveDevice?.(selected.id);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selected, onDisconnect, onRemoveDevice, canDraw, onUndo, onRedo, view]);

  // The other place this drawing writes to `liveStore.ts` (`LiveLitPath`
  // above owns `litCableId`/`litCableIdSet`/`litTrayKeySet`, on its own
  // hover-driven schedule). `useLayoutEffect`, not `useEffect` — this
  // commits before the browser paints, so a node subscribed to one of these
  // never draws one frame stale after a click or a drop.
  useLayoutEffect(() => {
    liveStore.setState({
      selected,
      dragFromPortId,
      livePortIds: livePortIds ?? EMPTY_STRING_SET,
      dropPreview,
      shakingRackId: shakingId,
      dimmedChassisId,
      cameraStop,
    });
  }, [liveStore, selected, dragFromPortId, livePortIds, dropPreview, shakingId, dimmedChassisId, cameraStop]);

  // No drawing node reads the live viewport; zoom-derived styling reads
  // these two custom properties, inherited from here, in CSS instead.
  const drawingStyle = { '--zoom': viewport.zoom, '--zoom-pct': zoomPercent } as CSSProperties;

  return (
    <LiveStoreProvider value={liveStore}>
    <LiveLitPath view={view} portalGroups={portalGroups} selected={selected} liveStore={liveStore} />
    <div
      className="drawing"
      ref={containerRef}
      style={drawingStyle}
      data-camera-stop={cameraStop}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        viewport={viewport}
        onViewportChange={handleViewportChange}
        onNodeClick={handleNodeClick}
        onPaneClick={() => onSelect(null)}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        panOnDrag
        panOnScroll={false}
        zoomOnScroll
        // UI-SPEC "Cables": a drag may be picked up from either end of a
        // future cable, and dropped on any other live port — loose mode is
        // what lets every port `Handle` (all declared `type="source"`,
        // `ChassisNode.tsx`) both start and receive a connection.
        connectionMode={ConnectionMode.Loose}
        connectionLineComponent={ConnectionLine}
        // This session's brief item 2 — "a click without movement selects,
        // a drag connects." React Flow's own threshold (`connectThreshold.ts`'s
        // own file header): `onConnectStart` never fires until the pointer
        // has moved this many flow px past the port glyph's own `onClick`
        // handler already firing for a plain click.
        connectionDragThreshold={PORT_CLICK_DRAG_THRESHOLD_PX}
        isValidConnection={isValidConnection}
        onConnectStart={handleConnectStart}
        onConnectEnd={handleConnectEnd}
        // ADR-0052 §5: the pane-level defaults a reader's document is drawn
        // under — every node above still names its own `draggable: canDraw`
        // too (React Flow's own per-node field wins over this default when
        // a node sets it explicitly), so dragging is refused both ways.
        nodesDraggable={canDraw}
        nodesConnectable={canDraw}
        elementsSelectable
        deleteKeyCode={null}
      >
        <Background gap={U_PX} size={1} />
      </ReactFlow>
      {/* This session's brief item 1 — "a cables view control: a small
          control on the canvas near the lens row... a view control, not a
          lens." An overlay sibling of the canvas, like `ColourPicker` below
          — never part of the React Flow pane, so it survives a pan or zoom
          untouched. */}
      <CablesViewControl value={cableVisibility} onChange={handleCableVisibilityChange} />
      {pendingConnect && (
        <ColourPicker
          kind={pendingConnect.kind}
          initial={lastSheathByKind[pendingConnect.kind] ?? sheathsFor(pendingConnect.kind)[0]}
          screenX={pendingConnect.screenX}
          screenY={pendingConnect.screenY}
          onConfirm={handlePickerConfirm}
          onCancel={handlePickerCancel}
        />
      )}
      {/* UI-SPEC "Config": "A drawer under the faceplate, not a separate
          page." Motion #9: "A surface slides in from the right and out
          again; the drawing beneath does not move" — an overlay sibling of
          the canvas, like `ColourPicker` above, never a layout change to
          the canvas itself; `drawing.css`'s own transition is the slide. */}
      {configDrawerContent != null && (
        <div className="drawing-config-drawer" role="complementary" aria-label="Config">
          {configDrawerContent}
        </div>
      )}
      {/* UI-SPEC "Inside a box" / Motion #10: "A box on a shelf opens at
          the faceplate stop by the same camera as everything else" — the
          inside stop is the same continuous camera one step further in,
          drawn as its own overlay rather than unmounting the rack canvas
          beneath it. */}
      {insideStopContent != null && (
        <div className="drawing-inside-stop" role="region" aria-label="Inside">
          {insideStopContent}
        </div>
      )}
    </div>
    </LiveStoreProvider>
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
