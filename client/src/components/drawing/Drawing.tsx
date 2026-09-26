import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
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
  type Node,
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
  RAIL_PX,
  U_PX,
  cableSagPath,
  cameraStopAt,
  overlapsRack,
  rackAtPoint,
  snapDropToU,
  sortFreeRuns,
  uToOffsetPx,
  zoomAboutPaneCentre,
} from './geometry';
import { ChassisNode, INLET_ANCHOR_HANDLE_ID, type ChassisNodeData, type ChassisNodeType } from './ChassisNode';
import { BundleEdge, type BundleEdgeData, type BundleEdgeType } from './BundleEdge';
import { CableEdge, type CableEdgeData, type CableEdgeType } from './CableEdge';
import { ColourPicker } from './ColourPicker';
import { IdCache, RefSignatureCache } from './idCache';
import { createLiveStore, EMPTY_STRING_SET, LiveStoreProvider } from './liveStore';
import { buildChassisNode } from './nodeBuild';
import { RACK_NODE_WIDTH, RackNode, rackNodeHeight, type RackNodeData, type RackNodeType } from './RackNode';
import { PortalTrayNode, PORTAL_TRAY_HEIGHT, type PortalTrayNodeData, type PortalTrayNodeType } from './PortalTrayNode';
import { ROW_LABEL_WIDTH, RowLabelNode, type RowLabelNodeData, type RowLabelNodeType } from './RowLabelNode';
import { ShelfPlate, type ShelfPlateNodeData, type ShelfPlateNodeType } from './ShelfPlate';
import { SurfaceNode, type SurfaceNodeData, type SurfaceNodeType } from './SurfaceNode';
import { chassisNodeId, parseNodeId, rackNodeId, rowLabelNodeId, shelfNodeId, surfaceNodeId, trayNodeId } from './nodeId';
import { findAnyPort, findFixture, findOccupant, locatePort, resolvePlaceNode } from './lookup';
import { liveTargetPortIds } from './liveTargets';
import { groupPortals, portalCountLabel } from './portals';
import { sheathsFor } from './sheath';
import { groupBundles } from './bundles';
import { litPathFor } from './paths';
import { faceplateItems, type FaceplateItem, powerLeadHandle, type Facing } from './elevation';
import { layoutRow, layoutSurfaces, mirroredRackX, rowKey, type RowLayout } from './rows';

const NODE_TYPES = {
  rack: RackNode,
  chassis: ChassisNode,
  tray: PortalTrayNode,
  rowLabel: RowLabelNode,
  surface: SurfaceNode,
  shelf: ShelfPlate,
};
const EDGE_TYPES = { cable: CableEdge, bundle: BundleEdge };

/** Vertical gap between one row's band and the next — session's own choice,
 * like `RACK_GAP_PX` beside it (below); not a document fact. */
const ROW_GAP_PX = 64;

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

/** The flow-space top of the `rowIndex`-th row's band — every row stacked
 * top to bottom, each band as tall as its tallest rack. */
function rowBandY(rowLayouts: readonly RowLayout[], rowIndex: number): number {
  let y = 0;
  for (let i = 0; i < rowIndex; i += 1) {
    const heights = rowLayouts[i]!.racks.map((r) => rackNodeHeight(r));
    y += Math.max(0, ...heights) + ROW_GAP_PX;
  }
  return y;
}

/** This session's brief items 2/3 — "Go to far end"/"Go to end A/B" both
 * select a port and pan the camera to its owning box at the faceplate
 * stop. This resolves WHICH React Flow node that is: the chassis node for a
 * rack chassis's own port (a PSU inlet included — the faceplate is always
 * the right box to land on, regardless of which handle a cable end actually
 * anchors to at this camera stop, `resolveEnd`'s own concern, below), the
 * shelf node for a shelf occupant's, the surface node for a surface
 * fixture's — `locatePort`'s own three places, the same one `resolveEnd`
 * already walks for a cable end. `null` when this view carries no such
 * port, never invented. */
function ownerNodeIdForPort(view: ClosetView, portId: string): string | null {
  const location = locatePort(view, portId);
  if (location == null) return null;
  if (location.place === 'chassis') return chassisNodeId(location.chassis.id);
  if (location.place === 'shelf') return shelfNodeId(location.shelf.id);
  return surfaceNodeId(location.surface.id);
}

/** Gap between a rack's frame and the portal tray(s) drawn above or below
 * it — session's own choice, not a board's literal pixel (`Main.dc.html`'s
 * two trays sit at a different overall scale than this drawing's flow
 * space). Kept small enough that the sagging cable connecting them reads
 * as continuous with the rack, per UI-SPEC "Portals": "Not either/or —
 * both." */
const TRAY_GAP_PX = 12;

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

/** Session-only gap between racks placed side by side — not a document
 * fact, never saved (brief: "remembered in component state only in this
 * session"; persisting layout is `OPEN-QUESTIONS` D5). */
const RACK_GAP_PX = 96;

/** How long the shake plays before the rejected drop's mark clears —
 * UI-SPEC "Motion" #2: "target shakes once sideways, lead springs back."
 * Matches `drawing.css`'s `--drawing-shake-ms`. */
const SHAKE_MS = 220;

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

  // GitHub issue #66: hover, selection, the lit path, drag state and
  // zoom-derived styling live here now, not on any node's own `data` — see
  // `liveStore.ts`'s own file header. One store per mounted drawing (never
  // recreated across renders, `useState`'s initialiser form), provided to
  // every node this drawing draws via `LiveStoreProvider` below.
  const [liveStore] = useState(() => createLiveStore());
  // GitHub issue #66, build item 2: each node object (and its `data`) keeps
  // its reference unless the device, rack or port it draws actually
  // changed — these four caches are what "actually changed" is decided
  // against, keyed by id, never by comparing the whole design
  // (`idCache.ts`'s own file header). One instance per mounted drawing,
  // like `liveStore` above.
  const nodeCacheRef = useRef(new IdCache<Node>());
  const faceplateItemsCacheRef = useRef(new IdCache<readonly FaceplateItem[]>());
  const chassisSigRef = useRef(new RefSignatureCache());
  const rackSigRef = useRef(new RefSignatureCache());
  // `items` (`faceplateItemsCacheRef`, below) gets a fresh array reference
  // on ANY document edit, even one that touched nothing in THIS rack (every
  // rack's own `chassis` array is rebuilt by `viewOf` on any edit at all) —
  // used directly as a dependency it would invalidate this rack's own node
  // the same way the raw `portSheath` Map once did (`portSheathSigRef`,
  // above); this is that same fix for `items`.
  const rackItemsSigRef = useRef(new RefSignatureCache());
  const shelfSigRef = useRef(new RefSignatureCache());
  const surfaceSigRef = useRef(new RefSignatureCache());
  const traySigRef = useRef(new RefSignatureCache());
  // `portSheath` (below) is a `Map`, rebuilt with a fresh reference on ANY
  // document edit (`view.cables` is rebuilt fresh by `viewOf` even when the
  // edit touched nothing about a cable) — used directly as a node cache
  // dependency, that reference churn alone invalidated every chassis, shelf
  // and surface node on ANY edit, not only one that actually recoloured a
  // port. This one signature, content-based like every other cache here,
  // is what every node's own dependency list carries instead.
  const portSheathSigRef = useRef(new RefSignatureCache());

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
  // GitHub issue #66: a `dragOverride` echoing `onNodeDrag`'s own live
  // position back into this chassis's OWN controlled `position` used to
  // live here — React Flow already moves an actively-dragged node itself,
  // internally, live, without a caller feeding its position back through
  // `nodes` at all (`onNodeDrag`'s own `node.position` argument, read by
  // `handleNodeDrag`/`handleNodeDragStop` below for the drop preview, is
  // already that live position) — echoing it back only gave this one
  // chassis's own node object a new reference on every pointer-move tick
  // of its own drag, exactly the reference churn this whole fix removes
  // everywhere else. Removed; a chassis's own `nodePosition` below is
  // always its document position now, so a plain reposition drag never
  // touches this chassis's own cached node at all until the drop actually
  // lands (a real edit, or a shake back to where it already was).
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
  const [hoveredCableId, setHoveredCableId] = useState<string | null>(null);
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
  const portSheath = useMemo(() => {
    const map = new Map<string, Sheath>();
    for (const cable of visibleCables) {
      if (cable.sheath == null) continue;
      for (const end of cable.ends) {
        if ('portId' in end) map.set(end.portId, cable.sheath);
      }
    }
    return map;
  }, [visibleCables]);
  const portSheathSig = portSheathSigRef.current.of('portSheath', portSheath, (value) =>
    JSON.stringify([...(value as ReadonlyMap<string, Sheath>).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );

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
      void rf.fitView(rackFitViewOptions(view.racks));
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

  // The bar's − / + zoom about the centre of the pane, not the top-left.
  useEffect(() => {
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
    void rf.fitView(closetFitViewOptions(view.racks, view.surfaces ?? []));
  }, [fitRequest, rf, view.racks, view.surfaces]);

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

  // UI-SPEC "Selection" + "Keeping it readable at forty cables" #3 / s6f #2:
  // hoisted ahead of the node-building loop below (unlike `litPath`'s own
  // fuller derivation, further down, which needs `portalGroups` that loop
  // has not built yet) so a rail hexagon's own hover — the same
  // `setHoveredCableId` `onHoverChange` already gives a `CableEdge`,
  // `RackNode.tsx`'s `onHoverInlet` below — marks its inlet's own glyph in
  // the same pass a cable's own hover already marks the cable itself,
  // "the same hover key" both read off `ChassisNodeData.litCableId`.
  const litCableId = selected?.kind === 'cable' ? selected.id : (hoveredCableId ?? null);

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
  // GitHub issue #66: s6g #1, UI-SPEC "Config": "Plate stays above, dimmed" —
  // pushed to `liveStore.ts` below (`dimmedChassisId`) so `ChassisNode.tsx`
  // applies its own dim class, rather than a `Node`-level `className` that
  // rebuilt this chassis's own node object every time it changed.
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

  // GitHub issue #66: identical for every chassis/shelf/surface node in
  // this drawing — a plain forward to `onSelect`, closing over nothing
  // node-specific — so hoisted once here rather than built fresh per node
  // per render, the same "the outer node object's own reference should not
  // move when nothing about that node changed" reasoning the node cache
  // itself is built for.
  const handleSelectPort = useCallback((portId: string) => onSelect({ kind: 'port', id: portId }), [onSelect]);
  const handleSelectFixture = useCallback((fixtureId: string) => onSelect({ kind: 'fixture', id: fixtureId }), [onSelect]);

  const nodes: Node[] = [];

  // s6g #1, UI-SPEC "Config": "Plate stays above, dimmed" — the selected
  // chassis's own flow-space centre, captured while its `basePosition` is
  // computed below, so the camera-recentre effect further down (which keeps
  // this plate above the config drawer rather than covering it) has a real
  // point to centre on without a second walk of `view.racks`.
  let selectedChassisFlowCentre: { x: number; y: number } | null = null;

  rowLayouts.forEach((layout, rowIndex) => {
    const y = rowBandY(rowLayouts, rowIndex);
    if (cameraStop === 'closet' && layout.racks.length > 0) {
      const key = rowKey(rowViews[rowIndex]!, rowIndex);
      const bandHeight = Math.max(0, ...layout.racks.map((r) => rackNodeHeight(r)));
      // GitHub issue #66, build item 2: this node's own reference is kept
      // across a render `layout.label`/`.elevation`/`bandHeight`/`y` did
      // not touch — `IdCache.get`'s own `build` thunk (`idCache.ts`) only
      // ever runs on a miss, so a cache hit below never even builds the
      // fresh `onFlip` closure, let alone a new node object for it.
      nodes.push(
        nodeCacheRef.current.get(rowLabelNodeId(key), [layout.label, layout.elevation, bandHeight, y], () => ({
          id: rowLabelNodeId(key),
          type: 'rowLabel',
          position: { x: -(ROW_LABEL_WIDTH + RACK_GAP_PX / 2), y },
          draggable: false,
          selectable: false,
          style: { width: ROW_LABEL_WIDTH, height: bandHeight },
          data: {
            label: layout.label,
            elevation: layout.elevation,
            onFlip: () => setRowFacing((prev) => ({ ...prev, [key]: prev[key] === 'rear' ? 'front' : 'rear' })),
          } satisfies RowLabelNodeData,
        })),
      );
    }

    for (const rack of layout.racks) {
      const pos = rackPositions[rack.id] ?? { x: 0, y };
      const elevation = elevationFor(rack.id);
      // ADR-0050 §1: every mounted chassis draws at every elevation now —
      // as its own faceplate for this face, or a plain plate when it has
      // none — so this is no longer a filtered subset the way the retired
      // `faces.ts`'s `chassisToDraw` was. Cached per rack id, keyed on
      // `rack.chassis`'s own reference and `elevation`: `view` itself is
      // unchanged across a hover/selection/zoom/drag render (`RacksPlace.tsx`
      // memoises it on `[doc, catalogue]`), so `rack.chassis` — and so
      // `items`, and so every `item.ports`/`.inlets` array nested in it — is
      // the SAME reference on every one of those renders, never rebuilt.
      const items = faceplateItemsCacheRef.current.get(rack.id, [rack.chassis, elevation], () =>
        faceplateItems(rack.chassis, elevation),
      );

      // `rack` itself is a fresh object on every real edit (`viewOf` rebuilds
      // the whole `ClosetView`, structural sharing included) — this
      // fingerprints THIS rack's own bounded slice of fields (never the
      // design around it, `idCache.ts`'s own file header), so an edit to
      // some OTHER device still reads as "this rack did not change" here.
      // `rack.freeRuns` is signed in a fixed order (`geometry.ts`'s own
      // `sortFreeRuns`, the same one `RackNode.tsx` itself sorts by before
      // drawing): `document/view.ts` gives no ordering guarantee across a
      // rebuild, and a no-op move (dropped back where it already was) still
      // asks the document layer to move it, still rebuilding the whole
      // view — reordering the SAME free runs would otherwise read as "this
      // rack changed" when nothing about it actually did.
      const rackSig = rackSigRef.current.of(rack.id, {
        label: rack.label,
        heightU: rack.heightU,
        freeRuns: sortFreeRuns(rack.freeRuns),
      });
      const itemsSig = rackItemsSigRef.current.of(rack.id, items);
      nodes.push(
        nodeCacheRef.current.get(rackNodeId(rack.id), [rackSig, itemsSig, elevation, pos.x, pos.y, canDraw], () => ({
          id: rackNodeId(rack.id),
          type: 'rack',
          position: pos,
          draggable: canDraw,
          selectable: true,
          style: { width: RACK_NODE_WIDTH, height: rackNodeHeight(rack) },
          data: {
            rack,
            chassisItems: items,
            elevation,
            onFlip: () => setRackFacing((prev) => ({ ...prev, [rack.id]: prev[rack.id] === 'rear' ? 'front' : 'rear' })),
            // s6f #2: reuses `setHoveredCableId` itself — the exact function
            // a `CableEdge`'s own `onHoverChange` already calls, and itself
            // a `useState` setter, permanently stable — so a rail hexagon's
            // hover and a cable's own hover write the same state, and this
            // dependency never invalidates the cache above on its own.
            onHoverInlet: setHoveredCableId,
          } satisfies RackNodeData,
        })),
      );

      for (const item of items) {
        const { chassis } = item;
        // Always the document's own position, never an echo of `onNodeDrag`'s
        // own live one — see this component's `dragOverride` removal note,
        // above, on why.
        const nodePosition = {
          x: pos.x + RAIL_PX,
          y: pos.y + RACK_HEADER_PX + uToOffsetPx(rack.heightU, chassis.positionU, chassis.heightU),
        };
        // `nodeBuild.ts`'s own `buildChassisNode` — pulled out of this loop
        // so a vitest can call the SAME code this loop calls, with the SAME
        // caches, across more than one call (`renderToStaticMarkup` runs a
        // component once; this needs no renderer at all to exercise twice).
        nodes.push(
          buildChassisNode(
            chassis,
            item.ports,
            item.inlets,
            elevation,
            nodePosition,
            canDraw,
            portSheath,
            portSheathSig,
            handleSelectPort,
            RACK_INNER_PX,
            chassis.heightU * U_PX,
            { nodeCache: nodeCacheRef.current, chassisSig: chassisSigRef.current },
          ),
        );
        if (chassis.id === selectedChassis?.id) {
          selectedChassisFlowCentre = {
            x: nodePosition.x + RACK_INNER_PX / 2,
            y: nodePosition.y + (chassis.heightU * U_PX) / 2,
          };
        }
      }

      // ADR-0051 §1/§2: a shelf takes rack units exactly as a chassis does —
      // one sibling React Flow node per `ShelfView`, positioned at its own
      // `positionU`/`.heightU` the same way `basePosition` above lays out a
      // chassis, never listed among `rack.chassis` (`document/view.ts`'s own
      // `rackView` keeps the two apart).
      for (const shelf of rack.shelves) {
        const shelfPosition = {
          x: pos.x + RAIL_PX,
          y: pos.y + RACK_HEADER_PX + uToOffsetPx(rack.heightU, shelf.positionU, shelf.heightU),
        };
        const shelfSig = shelfSigRef.current.of(shelf.id, shelf);
        nodes.push(
          nodeCacheRef.current.get(
            shelfNodeId(shelf.id),
            [shelfSig, elevation, portSheathSig, shelfPosition.x, shelfPosition.y, handleSelectPort],
            () => ({
              id: shelfNodeId(shelf.id),
              type: 'shelf',
              position: shelfPosition,
              // Selection/opening is handled inside `ShelfPlate.tsx` itself
              // (its own `onClick`, stopped before it reaches React Flow) —
              // the same `draggable: false, selectable: false` choice this
              // component already makes for a `SurfaceNode`, above.
              draggable: false,
              selectable: false,
              zIndex: 10,
              style: { width: RACK_INNER_PX, height: shelf.heightU * U_PX },
              data: {
                shelf,
                elevation,
                // `api/catalogue.ts` carries no shelf slot-capacity field
                // yet — `ShelfPlateNodeData.slotCount`'s own doc on why
                // `null` (occupants only, no gap invented) is the honest
                // reading until it does.
                slotCount: null,
                onSelectShelf: () => onSelect({ kind: 'shelf', id: shelf.id }),
                onSelectOccupant: (occupantId: string) => {
                  onSelect({ kind: 'occupant', id: occupantId });
                  // Motion #10: "A box on a shelf opens at the faceplate
                  // stop by the same camera as everything else" — one
                  // continuous `setCenter`, the same camera every other
                  // zoom change in this drawing already moves, never a
                  // second, independent jump.
                  const centreX = shelfPosition.x + RACK_INNER_PX / 2;
                  const centreY = shelfPosition.y + (shelf.heightU * U_PX) / 2;
                  void rf.setCenter(centreX, centreY, { zoom: CAMERA_STOPS.faceplate / 100, duration: 300 });
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

  // s6g #1, UI-SPEC "Config": "Plate stays above, dimmed" — `drawing.css`'s
  // `.drawing-config-drawer` reserves the pane's own bottom
  // `DRAWER_HEIGHT_FRACTION` for the drawer; this keeps the selected
  // chassis inside the remaining top strip, centred in it, whenever the
  // drawer opens — an edge-triggered `setCenter` (the same call Motion #10's
  // shelf-occupant open already makes, above), fired once on the transition
  // into "a chassis is selected and the camera reads the faceplate stop,"
  // never on every zoom tick while it stays there, so a person's own
  // subsequent pan or scroll is never fought mid-read.
  const configDrawerOpen = configDrawerContent != null;
  useEffect(() => {
    if (!configDrawerOpen || selectedChassisFlowCentre == null) return;
    const paneHeight = containerRef.current?.clientHeight ?? 0;
    if (paneHeight === 0) return;
    const zoomLevel = CAMERA_STOPS.faceplate / 100;
    const DRAWER_HEIGHT_FRACTION = 0.46; // matches `drawing.css`'s own literal
    const plateScreenFraction = (1 - DRAWER_HEIGHT_FRACTION) / 2; // the visible strip's own midpoint
    const targetY = selectedChassisFlowCentre.y + (paneHeight * (0.5 - plateScreenFraction)) / zoomLevel;
    void rf.setCenter(selectedChassisFlowCentre.x, targetY, { zoom: zoomLevel, duration: 300 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- edge-triggered
    // on purpose (see comment above): `selectedChassisFlowCentre` itself is
    // rebuilt fresh every render and would fire this on every pixel of a
    // person's own drag or scroll if it were a dependency.
  }, [configDrawerOpen, selectedChassis?.id, rf]);

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

  for (const placement of [...surfacesLayout.panels, ...(surfacesLayout.floor ? [surfacesLayout.floor] : [])]) {
    // `placement` itself carries the whole surface, fixtures and all — see
    // `rows.ts`'s own `SurfacePlacement`. Fingerprinted the same way a
    // rack/chassis/shelf is (`idCache.ts`'s own file header): a hover- or
    // zoom-only render reuses this instantly (`view` itself unchanged,
    // `surfacesLayout`'s own `useMemo` above keeps `placement`'s reference
    // too), a real edit re-stringifies only this one surface's own bounded
    // slice.
    const surfaceSig = surfaceSigRef.current.of(placement.surface.id, placement);
    nodes.push(
      nodeCacheRef.current.get(
        surfaceNodeId(placement.surface.id),
        [surfaceSig, portSheathSig, handleSelectPort, handleSelectFixture],
        () => ({
          id: surfaceNodeId(placement.surface.id),
          type: 'surface',
          position: { x: placement.x, y: placement.y },
          draggable: false,
          selectable: false,
          style: { width: placement.widthPx, height: placement.heightPx },
          data: {
            placement,
            uPx: U_PX,
            onSelectPort: handleSelectPort,
            // ADR-0051 §1/§2, this session's brief item 3 — "clicking a
            // fixture on a surface selects it."
            onSelectFixture: handleSelectFixture,
            portSheath,
          } satisfies SurfaceNodeData,
        }),
      ),
    );
  }

  // This session's brief items 2/3 — "Go to far end"/"Go to end A/B ...
  // pans the camera to it at the faceplate stop, one camera." Every rack
  // chassis, shelf and surface node this closet draws is on `nodes` by now
  // (the rows loop and the surfaces loop just above, both already run) —
  // this reads the SELECTED port's own owning box straight off that array,
  // the same "search what is already built" reading `resolveEnd`'s own
  // `findAnyPort`/`resolvePlaceNode` already give a cable end, below.
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

  useEffect(() => {
    if (selectedPortId == null || selectedPortOwnerCentre == null) return;
    void rf.setCenter(selectedPortOwnerCentre.x, selectedPortOwnerCentre.y, { zoom: CAMERA_STOPS.faceplate / 100, duration: 300 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- edge-triggered
    // on the selected port's own id alone, the same reasoning
    // `configDrawerOpen`'s own effect above already gives
    // `selectedChassisFlowCentre`: recomputed fresh every render, and
    // listing it here would fire this on every pixel of a person's own pan
    // or scroll once a port happens to be selected.
  }, [selectedPortId, rf]);

  // UI-SPEC "Portals": one tray node per (rack, side, far label) group —
  // `portals.ts` does the grouping; this only lays the resulting boxes out
  // above or below their rack, stacking more than one on the same side.
  const portalGroups = useMemo(() => groupPortals(view), [view]);

  // UI-SPEC "Selection" + "Keeping it readable at forty cables" #3: the
  // selected (or hovered) cable's *whole physical path* lights at full
  // opacity with a pale halo — through a panel's paired port, out to a
  // portal tray — and everything off that path sits at the phantom
  // opacity. Nothing lit leaves every cable at its plain, undimmed colour.
  // (`litCableId` itself is computed above, ahead of the node-building loop.)
  const somethingLit = litCableId != null;
  const litPath = useMemo(
    () => (litCableId ? litPathFor(view, litCableId, portalGroups) : null),
    [view, litCableId, portalGroups],
  );
  const litCableIdSet = useMemo(() => new Set(litPath?.cableIds ?? []), [litPath]);
  const litTrayKeySet = useMemo(() => new Set(litPath?.trayKeys ?? []), [litPath]);

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
    // `lit` used to live on `data` directly, rebuilt (and so this tray's
    // node object rebuilt) every time `litCableId` changed anywhere in the
    // drawing — `PortalTrayNode.tsx` now reads its own answer off
    // `liveStore.ts`'s `litTrayKeySet` itself, keyed by `group.key`
    // (`trayKey` below).
    const traySig = traySigRef.current.of(group.key, group);
    nodes.push(
      nodeCacheRef.current.get(trayNodeId(group.key), [traySig, pos.x, y], () => ({
          id: trayNodeId(group.key),
          type: 'tray',
          position: { x: pos.x, y },
          draggable: false,
          selectable: false,
          style: { width: RACK_NODE_WIDTH, height: PORTAL_TRAY_HEIGHT },
          data: {
            label: group.label,
            countLabel: portalCountLabel(group),
            side: group.side,
            trayKey: group.key,
          } satisfies PortalTrayNodeData,
        }),
      ),
    );
  }

  // GitHub issue #66: drop any node this render never asked the cache for —
  // a rack, chassis, shelf, surface or tray a document edit removed. The
  // `RefSignatureCache`s above are left to grow slowly instead (small
  // strings, keyed by an id that is itself gone from `view` the moment the
  // thing it named is removed) rather than threading a second "every id
  // still live" set through four loops for what stays a bounded cost.
  nodeCacheRef.current.sweep();

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
      lit: somethingLit && litCableIdSet.has(cable.id),
      dimmed: somethingLit && !litCableIdSet.has(cable.id),
      onSelect: (cableId: string) => onSelect({ kind: 'cable', id: cableId }),
      onHoverChange: setHoveredCableId,
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
      dimmed: somethingLit && !bundle.members.some((m) => litCableIdSet.has(m.id)),
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

  // GitHub issue #66: the one place this drawing writes to `liveStore.ts`.
  // `useLayoutEffect`, not `useEffect` — this commits before the browser
  // paints, so a node subscribed to one of these (`ChassisNode.tsx`'s
  // `useChassisLiveData` and its siblings) never draws one frame stale
  // after a click or a drop. Every value here is already computed above for
  // this render's own `edges`/camera-recentre logic; this is the only place
  // that turns them into something a node can subscribe to piecemeal
  // instead of receiving whole through `data`.
  useLayoutEffect(() => {
    liveStore.setState({
      selected,
      litCableId,
      litTrayKeySet,
      dragFromPortId,
      livePortIds: livePortIds ?? EMPTY_STRING_SET,
      dropPreview,
      shakingRackId: shakingId,
      dimmedChassisId,
    });
  }, [liveStore, selected, litCableId, litTrayKeySet, dragFromPortId, livePortIds, dropPreview, shakingId, dimmedChassisId]);

  return (
    <LiveStoreProvider value={liveStore}>
    <div className="drawing" ref={containerRef} onDrop={handleDrop} onDragOver={handleDragOver}>
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
