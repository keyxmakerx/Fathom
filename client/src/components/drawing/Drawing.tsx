import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import {
  Background,
  ConnectionMode,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  useReactFlow,
  type ConnectionLineComponentProps,
  type Edge,
  type EdgeMouseHandler,
  type FinalConnectionState,
  type IsValidConnection,
  type NodeMouseHandler,
  type Node as RFNode,
  type OnConnectEnd,
  type OnConnectStart,
  type OnMove,
  type OnNodeDrag,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import '../../styles/drawing.css';
import './plans-canvas.css';

import { compatible } from '../../document/compat';
import { ChecksCanvasBridge, useChecksFade } from '../checks/fade';
import { mediaCandidates } from '../checks/checksModel';
import { useChecksApi } from '../checks/checksStore';
import { PlanGhostEdge } from './PlanGhostEdge';
import { PlansCanvasBridge, usePlansFade } from './plansFade';
import type { PortTarget } from './plansMarks';
import { Callout } from './Callout';
import { useSettledView } from './settledView';
import { endOffScreen, stubTagText, type StubEnd } from './stubs';
import type { Bundle } from './bundles';
import { leadsFor, placeLabels, type LabelItem, type PortPoint } from './cableEnds';
import { faceplateLayoutFor, plateItems } from './faceplate';
import { UNNAMED_HOSTNAME, type CableKind, type CableView, type ChassisView, type ClosetView, type DrawingActions, type RackView, type RowView, type Selection, type Sheath } from './contract';
import { PORT_CLICK_DRAG_THRESHOLD_PX } from './connectThreshold';
import { decodePaletteDrag, getDraggedUnits, PALETTE_DRAG_MIME } from './dnd';
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
  zoomBandAt,
  type CameraStop,
  type ZoomBand,
} from './geometry';
import { ChassisNode, INLET_ANCHOR_HANDLE_ID, type ChassisNodeData, type ChassisNodeType } from './ChassisNode';
import { BundleEdge, type BundleEdgeData, type BundleEdgeType } from './BundleEdge';
import { CableEdge, type CableEdgeData, type CableEdgeType } from './CableEdge';
import { ColourPicker } from './ColourPicker';
import { ContextMenu } from './ContextMenu';
import { parseFreeNodeId } from './freeLayout';
import { CanvasTools, type CanvasTool } from './CanvasTools';
import { useWheelMode } from './canvasPrefs';
import { FREE_EDGE_TYPES, FREE_NODE_TYPES, useFreeLayer } from './useFreeLayer';
import { menuItemsFor, type MenuActions, type MenuTarget } from './contextMenuItems';
import { createLiveStore, EMPTY_STRING_SET, LiveStoreProvider, useLive, type LiveStore } from './liveStore';
import { portSheathEqual } from './nodeEquality';
import { RACK_NODE_WIDTH, RackNode, rackNodeHeight, type RackNodeType } from './RackNode';
import { PortalTrayNode, type PortalTrayNodeType } from './PortalTrayNode';
import { RowLabelNode, type RowLabelNodeType } from './RowLabelNode';
import { ShelfPlate, type ShelfPlateNodeType } from './ShelfPlate';
import { SurfaceNode, type SurfaceNodeType } from './SurfaceNode';
import { chassisNodeId, parseNodeId, rackNodeId, shelfNodeId, surfaceNodeId, trayNodeId } from './nodeId';
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
import type { Person } from '../../api/live';
import { buildDrawingNodes, ownerNodeIdForPort } from './buildDrawingNodes';
import { PEER_DOT_PX, peerMarks } from './peerMarks';
import { useDrawingNodeCaches } from './useDrawingNodeCaches';

const NODE_TYPES = {
  rack: RackNode,
  chassis: ChassisNode,
  tray: PortalTrayNode,
  rowLabel: RowLabelNode,
  surface: SurfaceNode,
  shelf: ShelfPlate,
};
const EDGE_TYPES = { cable: CableEdge, bundle: BundleEdge, planGhost: PlanGhostEdge };
const ALL_NODE_TYPES = { ...NODE_TYPES, ...FREE_NODE_TYPES };
const ALL_EDGE_TYPES = { ...EDGE_TYPES, ...FREE_EDGE_TYPES };
const PAN_BUTTONS = [0, 1];
const MIDDLE_ONLY = [1];

// React Flow's corner credit link is hidden; the About page credits the library (ADR-0060).
const PRO_OPTIONS = { hideAttribution: true };

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
function rackFitViewOptions(racks: readonly { id: string }[], free: readonly { id: string }[] = []) {
  return {
    nodes: [...racks.map((r) => ({ id: rackNodeId(r.id) })), ...free],
    padding: 0.1,
    maxZoom: CAMERA_STOPS.rack / 100,
  };
}

/** Fit every rack AND surface: the bar's own "Fit to view" — the whole
 * closet. `minZoom` goes below `MIN_ZOOM` to match the bar's own +/- floor. */
function closetFitViewOptions(racks: readonly { id: string }[], surfaces: readonly { id: string }[], free: readonly { id: string }[] = []) {
  return {
    nodes: [...racks.map((r) => ({ id: rackNodeId(r.id) })), ...surfaces.map((s) => ({ id: surfaceNodeId(s.id) })), ...free],
    padding: 0.1,
    minZoom: 0.1,
    maxZoom: CAMERA_STOPS.rack / 100,
  };
}

/** The camera's glide: linear, so its zoom runs straight between the two ends
 * and never dips into another stop or band on the way. */
const GLIDE = { duration: 300, interpolate: 'linear' } as const;

/** Matches `.drawing-config-drawer`'s height in `drawing.css`. */
const DRAWER_HEIGHT_FRACTION = 0.46;

/** The flow point to centre on so `centre` sits mid-way down the strip above the drawer. */
function centreAboveDrawer(centre: { x: number; y: number }, zoomLevel: number, pane: HTMLElement | null): { x: number; y: number } | null {
  const paneHeight = pane?.clientHeight ?? 0;
  if (paneHeight === 0) return null;
  const stripMiddle = (1 - DRAWER_HEIGHT_FRACTION) / 2;
  return { x: centre.x, y: centre.y + (paneHeight * (0.5 - stripMiddle)) / zoomLevel };
}

export interface DrawingProps extends DrawingActions {
  view: ClosetView;
  /** Others in this view; each gets an initials dot on the thing they have selected. */
  peers?: readonly Person[];
  selected: Selection | null;
  /** The bar's zoom percentage, e.g. `100` — `Shell`'s own `zoom` prop
   * convention. Kept in agreement with React Flow's viewport: this
   * component is the one place that converts between the two. */
  zoom: number;
  onZoomChange: (zoom: number) => void;
  /** Right-click "Plan a change" on a device (ADR-0061 round 7). Absent, or a reader: no menu item. */
  onPlanChange?: (elementId: string) => void;
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
  /** Shown over an empty design, saying what to do next (ADR-0060 decision 4). */
  emptyHint?: string | null;
  /** Opens a device's config drawer or inside view, as a double-click does;
   * a new object each time (the same edge-triggered shape `fitRequest` has). */
  openRequest?: { id: string; view: 'config' | 'inside' } | null;
  /** The chassis whose callout is showing, or null; the caller keeps the details panel closed meanwhile. */
  onCalloutChange?: (id: string | null) => void;
  /** The Cables list's own draw rule, already computed once by the caller
   * (`racks/RacksPlace.tsx`, which holds the `Document` a VLAN or a tag
   * group needs — this drawing never imports it, and never runs the draw
   * rule itself). `undefined` means "All": every cable draws, nothing
   * dashed. */
  drawnCableIds?: ReadonlySet<string>;
  dashedCableIds?: ReadonlySet<string>;
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
  /** `undefined` means every cable draws — nothing to exclude. Present, a
   * selected or hovered cable outside it lights nothing and dims nothing
   * ("the lit path only reads drawn cables"): the raw id is dropped to
   * `null` before it ever reaches `litPathFor`, the same as no selection at
   * all, rather than asking that function for a path through a cable it was
   * never given. */
  drawnCableIds?: ReadonlySet<string>;
}

/** Subscribed to `liveStore.ts`'s own `hoveredCableId`, written there
 * directly by a hover — recomputes the lit path and writes it back, so only this re-renders on a hover, never the node-building loop below it. */
function LiveLitPath({ view, portalGroups, selected, liveStore, drawnCableIds }: LiveLitPathProps) {
  const hoveredCableId = useLive((s) => s.hoveredCableId);
  const rawLitCableId = selected?.kind === 'cable' ? selected.id : hoveredCableId;
  const litCableId = rawLitCableId != null && drawnCableIds != null && !drawnCableIds.has(rawLitCableId) ? null : rawLitCableId;
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
  peers,
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
  onDuplicateDevice,
  onAddDevice,
  onAddRack,
  onAddWall,
  onPasteConfig,
  onPlanChange,
  onOpenDevice,
  onResizeShelf,
  onAddFreeBox,
  onAddDeviceAt,
  onMoveFree,
  onConnectBoxes,
  onAddLabel,
  onSetLabel,
  onRemoveFree,
  onDuplicateFree,
  onUndo,
  onRedo,
  canDraw,
  renderConfigDrawer,
  renderInsideStop,
  litPortLabel,
  emptyHint,
  openRequest,
  onCalloutChange,
  drawnCableIds,
  dashedCableIds,
}: DrawingProps) {
  const rf = useReactFlow<FlowNode>();

  // Hover, selection, drag state and the camera stop, shared with every node
  // through `LiveStoreProvider` below rather than through node `data`.
  const [liveStore] = useState(() => createLiveStore());
  const caches = useDrawingNodeCaches();

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
  // React Flow never moves a dragged node itself here (no `onNodesChange`);
  // this override moves only the one chassis being dragged.
  const [dragOverride, setDragOverride] = useState<{ id: string; position: { x: number; y: number } } | null>(null);
  const [dropPreview, setDropPreview] = useState<DropPreview>({});
  const [shakingId, setShakingId] = useState<string | null>(null);
  // React Flow owns the camera; this component keeps only the stop and the
  // zoom band, and updates them when the camera crosses into another.
  const [defaultViewport] = useState<Viewport>(() => ({ x: 0, y: 0, zoom: Math.max(zoom, 1) / 100 }));
  const [cameraStop, setCameraStop] = useState<CameraStop>(() => cameraStopAt(Math.max(zoom, 1)));
  const [zoomBand, setZoomBand] = useState<ZoomBand>(() => zoomBandAt(Math.max(zoom, 1)));
  const shakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `FinalConnectionState.to` (below) is already screen space, but relative
  // to the React Flow container rather than the page — this is what turns
  // it into the page coordinates the colour picker's `position: fixed`
  // overlay actually needs.
  const containerRef = useRef<HTMLDivElement>(null);
  // What a plain left-drag on empty canvas does. Pan by default; Shift+drag draws a selection box either way.
  const [tool, setTool] = useState<CanvasTool>('pan');
  const [wheel, setWheel] = useWheelMode('scroll');
  const free = useFreeLayer({
    view,
    canDraw,
    rf,
    containerRef,
    selected,
    onSelect,
    tool,
    actions: { onAddFreeBox, onAddDeviceAt, onMoveFree, onConnectBoxes, onAddLabel, onSetLabel, onRemoveFree, onDuplicateFree },
  });

  // ADR-0060 decision 4: a right-click opens Fathom's own menu, not the
  // browser's. The items are built at render from the current actions, so a
  // choice never acts through a handler the menu opened over. A reader gets
  // only Details, the same `canDraw` gate the delete key has.
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null);
  // Zoom never opens a device; only Open, a double-click or "Show on rack" does.
  const [opened, setOpened] = useState<{ id: string; view: 'config' | 'inside' } | null>(null);
  // A click on a device's name draws its callout, led from the name; any other
  // click on the plate only selects (and opens the details panel).
  const [callout, setCallout] = useState<{ id: string; left: number; right: number; y: number } | null>(null);
  const openedRef = useRef(opened);
  const calloutRef = useRef(callout);
  calloutRef.current = callout;
  openedRef.current = opened;
  useEffect(() => {
    if (callout != null && (selected?.kind !== 'chassis' || selected.id !== callout.id)) setCallout(null);
  }, [callout, selected]);
  useEffect(() => {
    onCalloutChange?.(callout?.id ?? null);
  }, [callout, onCalloutChange]);
  const openChassis = useCallback(
    (id: string, view: 'config' | 'inside' = 'config') => {
      onSelect({ kind: 'chassis', id });
      if (onOpenDevice) {
        // ADR-0060 decision 10: Open goes into the device. Its place on this canvas is where equipment dropped there lands.
        const at = rf.getInternalNode(chassisNodeId(id))?.internals.positionAbsolute ?? rf.getInternalNode(`free:${id}`)?.internals.positionAbsolute;
        onOpenDevice(id, view === 'inside', at ?? null);
        return;
      }
      setOpened({ id, view });
    },
    [onSelect, onOpenDevice, rf],
  );
  const onOpenInside = renderInsideStop ? (id: string) => openChassis(id, 'inside') : undefined;
  const freeMenuActions: Partial<MenuActions> = {
    onAddInRack: onAddDeviceAt ? (rackId, u, at) => free.openAdd(at.screen, at.flow, { rackId, positionU: u }) : undefined,
    onAddBoxHere: onAddFreeBox ? (at) => free.openAdd(at.screen, at.flow) : undefined,
    onAddLabelHere: onAddLabel ? (form, flow) => free.addLabelAt(form, flow) : undefined,
    onDuplicateFree: onDuplicateFree ? (ids) => void onDuplicateFree(ids, 24, 24) : undefined,
    onRemoveFree,
  };
  const menuActions: MenuActions = canDraw
    ? { onSelect, onOpen: openChassis, onOpenInside, onDuplicateDevice, onRemoveDevice, onDisconnect, onAddDevice, onAddRack, onAddWall, onPasteConfig, onPlanChange, ...freeMenuActions }
    : { onSelect, onOpen: openChassis, onOpenInside };
  const menuActionsRef = useRef(menuActions);
  useLayoutEffect(() => {
    menuActionsRef.current = menuActions;
  });
  const closeMenu = useCallback(() => setMenu(null), []);
  const openMenu = useCallback((event: { clientX: number; clientY: number; preventDefault(): void }, target: MenuTarget) => {
    const rect = containerRef.current?.getBoundingClientRect();
    // Nothing to offer (a reader on the empty canvas): the browser's own menu.
    if (!rect || menuItemsFor(target, menuActionsRef.current).length === 0) return;
    event.preventDefault();
    setMenu({ x: event.clientX - rect.left, y: event.clientY - rect.top, target });
  }, []);
  // A wall, shelf, tray or row label has no menu of its own yet; it offers
  // what the empty canvas does.
  const paneTarget = useCallback(
    (event: { clientX: number; clientY: number }): MenuTarget => {
      const rect = containerRef.current?.getBoundingClientRect();
      return {
        kind: 'pane',
        at: { screen: { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }, flow: rf.screenToFlowPosition({ x: event.clientX, y: event.clientY }) },
      };
    },
    [rf],
  );
  const handleNodeContextMenu: NodeMouseHandler = useCallback(
    (event, node) => {
      const parsedFree = parseFreeNodeId(node.id);
      const rackNode = parseNodeId(node.id);
      if (rackNode?.kind === 'rack') {
        const target = paneTarget(event);
        const rack = view.racks.find((r) => r.id === rackNode.id);
        const pos = rack ? rackPositions[rack.id] : undefined;
        if (rack && pos && target.kind === 'pane' && target.at) {
          const u = rack.heightU - Math.floor((target.at.flow.y - pos.y - RACK_HEADER_PX) / U_PX);
          const taken = [...rack.chassis, ...rack.shelves].some((c) => u >= c.positionU && u < c.positionU + c.heightU);
          if (u >= 1 && u <= rack.heightU && !taken) return openMenu(event, { kind: 'rack', id: rack.id, freeU: { u, ...target.at } });
        }
        return openMenu(event, { kind: 'rack', id: rackNode.id });
      }
      if (parsedFree) return openMenu(event, { kind: parsedFree.kind === 'box' ? 'free' : 'label', id: parsedFree.id });
      openMenu(event, parseNodeId(node.id) ?? paneTarget(event));
    },
    [openMenu, paneTarget, view.racks, rackPositions],
  );
  const handleEdgeContextMenu: EdgeMouseHandler = useCallback(
    (event, edge) =>
      openMenu(event, edge.type === 'cable' ? { kind: 'cable', id: edge.id } : edge.type === 'line' ? { kind: 'line', id: edge.id.replace(/^line:/, '') } : paneTarget(event)),
    [openMenu, paneTarget],
  );
  const handlePaneContextMenu = useCallback(
    (event: { clientX: number; clientY: number; preventDefault(): void }) => openMenu(event, paneTarget(event)),
    [openMenu, paneTarget],
  );

  // Drag-to-connect (UI-SPEC "Cables", "Drag-to-connect") and cable
  // selection/hover (UI-SPEC "Selection").
  const [dragFromPortId, setDragFromPortId] = useState<string | null>(null);
  const [pendingConnect, setPendingConnect] = useState<PendingConnect | null>(null);
  const checks = useChecksApi();
  const [lastSheathByKind, setLastSheathByKind] = useState<LastSheathByKind>({});
  // Writes straight to `liveStore.ts` rather than to component state, so
  // hovering a cable or a rail hexagon never re-renders this component.
  const handleHoverCable = useCallback((cableId: string | null) => liveStore.setState({ hoveredCableId: cableId }), [liveStore]);
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

  // The draw rule itself runs once, in the caller (`racks/RacksPlace.tsx`,
  // which holds the `Document` a VLAN or a tag group needs); this only
  // filters the real `view.cables` down to the ids it was handed.
  // `drawnCableIds` absent means "All": every cable draws. The boxes
  // themselves (chassis, shelf, surface, portal tray) are built from the
  // real `view`, never this filtered list, so a hidden cable never removes
  // anything but itself, its bundle and nothing at all off a port's own
  // fill.
  const drawnCables = useMemo(
    () => (drawnCableIds ? (view.cables ?? []).filter((c) => drawnCableIds.has(c.id)) : (view.cables ?? [])),
    [view.cables, drawnCableIds],
  );

  // Decision 7 — "Port fill comes from every cable, not only the drawn
  // ones": unlike `drawnCables` above, this reads the full `view.cables`,
  // so a hidden or filtered-out cable's two ports keep their fill.
  const freshPortSheath = useMemo(() => {
    const map = new Map<string, Sheath>();
    for (const cable of view.cables ?? []) {
      if (cable.sheath == null) continue;
      for (const end of cable.ends) {
        if ('portId' in end) map.set(end.portId, cable.sheath);
      }
    }
    return map;
  }, [view.cables]);
  // The previous map when no entry changed, so an edit that touches no cable
  // colour leaves every chassis, shelf and surface node as it was.
  const portSheath = caches.portSheath.get('portSheath', freshPortSheath, portSheathEqual);
  caches.portSheath.sweep();

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
    // Not `draggedRackIds`: a drag must not re-run this; the next flip or
    // document change reads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowLayouts]);

  // Fits every rack, no closer than the rack stop, on mount and when the set of
  // racks changes, once every rack has its position (a new one lands a render later).
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
      void rf.fitView(rackFitViewOptions(view.racks, free.fitIds));
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

  // The percentage button's fit; never fires on the first render. Frames
  // every rack and every surface — the whole closet, not just its racks.
  const prevFitRequestRef = useRef(fitRequest);
  useEffect(() => {
    if (fitRequest == null || fitRequest === prevFitRequestRef.current) return;
    prevFitRequestRef.current = fitRequest;
    void rf.fitView(closetFitViewOptions(view.racks, view.surfaces ?? [], free.fitIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a press of the button refits
  }, [fitRequest, rf, view.racks, view.surfaces]);

  // Called every frame of any camera move; sets state only when the camera
  // crosses into another stop or zoom band, so a wheel tick renders nothing.
  const cameraStopRef = useRef(cameraStop);
  const zoomBandRef = useRef(zoomBand);
  const followCamera = useCallback((vp: Viewport) => {
    const pct = Math.round(vp.zoom * 100);
    const stop = cameraStopAt(pct);
    if (stop !== cameraStopRef.current) {
      cameraStopRef.current = stop;
      setCameraStop(stop);
    }
    const band = zoomBandAt(Math.round(vp.zoom * 1000) / 10);
    if (band !== zoomBandRef.current) {
      zoomBandRef.current = band;
      setZoomBand(band);
    }
  }, []);
  const zoomRef = useRef(zoom);
  const onZoomChangeRef = useRef(onZoomChange);
  useLayoutEffect(() => {
    zoomRef.current = zoom;
    onZoomChangeRef.current = onZoomChange;
  });
  // A move with a source event is a person's wheel, pinch or drag; a
  // programmatic `setCenter`, `fitView` or auto-pan has none.
  const personMovingRef = useRef(false);
  const handleMoveStart: OnMove = useCallback((event) => {
    if (event != null) {
      personMovingRef.current = true;
      setMenu(null);
    }
  }, []);
  const settled = useSettledView();
  const stubbedRef = useRef(new Set<string>());
  const handleMove: OnMove = useCallback((_event, vp) => followCamera(vp), [followCamera]);
  const handleMoveEnd: OnMove = useCallback(
    (_event, vp) => {
      personMovingRef.current = false;
      followCamera(vp);
      settled.settle(vp);
      const pct = Math.round(vp.zoom * 100);
      if (pct !== zoomRef.current) onZoomChangeRef.current(pct);
    },
    [followCamera, settled.settle],
  );

  const triggerShake = useCallback((id: string) => {
    if (shakeTimer.current != null) clearTimeout(shakeTimer.current);
    setShakingId(id);
    shakeTimer.current = setTimeout(() => setShakingId(null), SHAKE_MS);
  }, []);

  useEffect(() => () => {
    if (shakeTimer.current != null) clearTimeout(shakeTimer.current);
  }, []);

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
  const calloutRack = selectedChassis != null ? view.racks.find((r) => r.chassis.some((c) => c.id === selectedChassis.id)) : undefined;
  const openedChassis = selectedChassis != null && opened?.id === selectedChassis.id ? selectedChassis : null;
  const configDrawerContent: ReactNode =
    openedChassis != null && opened?.view === 'config' ? (renderConfigDrawer?.(openedChassis) ?? null) : null;
  const insideStopContent: ReactNode =
    openedChassis != null && opened?.view === 'inside' ? (renderInsideStop?.(openedChassis) ?? null) : null;
  useEffect(() => {
    if (opened != null && selectedChassis?.id !== opened.id) setOpened(null);
  }, [opened, selectedChassis?.id]);
  useEffect(() => {
    if (openRequest != null) setOpened({ id: openRequest.id, view: openRequest.view });
  }, [openRequest]);
  // UI-SPEC "Config": "Plate stays above, dimmed" — pushed to
  // `liveStore.ts` below so `ChassisNode.tsx` applies its own dim class.
  const dimmedChassisId = configDrawerContent != null ? (selectedChassis?.id ?? null) : null;
  // Glyphs draw once a port is big enough to read; close in, a bundle is its separate cables.
  const showPortGlyphs = zoomBand >= 125;
  const splitBundles = zoomBand >= 200;

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

  // One stable function every node shares, rather than a closure per node.
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
  // A box on a shelf opens at the faceplate stop by the same continuous camera every other selection moves — never a second, independent jump.
  const onOpenShelfOccupant = useCallback(
    (occupantId: string, centreX: number, centreY: number) => {
      onSelect({ kind: 'occupant', id: occupantId });
      void rf.setCenter(centreX, centreY, { zoom: CAMERA_STOPS.faceplate / 100, ...GLIDE });
    },
    [onSelect, rf],
  );

  // One tray node per (rack, side, far label) group — `portals.ts` does the grouping; `buildDrawingNodes.ts` lays the boxes out.
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

  // Every rack, chassis, shelf, surface and tray node this closet draws —
  // `buildDrawingNodes.ts`'s own pure function, so a vitest can exercise the same code and caches this component calls, with no DOM at all.
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
      onResizeShelf,
      onOpenShelfOccupant,
      onHoverInlet: handleHoverCable,
      surfacesLayout,
      portalGroups,
    },
    caches.nodes,
  );

  // Centres the selected chassis in the strip above the drawer at the faceplate
  // stop, once when the drawer opens or the chassis changes.
  const configDrawerOpen = configDrawerContent != null;
  useEffect(() => {
    if (!configDrawerOpen || selectedChassisFlowCentre == null) return;
    const zoomLevel = CAMERA_STOPS.faceplate / 100;
    const target = centreAboveDrawer(selectedChassisFlowCentre, zoomLevel, containerRef.current);
    if (target != null) void rf.setCenter(target.x, target.y, { zoom: zoomLevel, ...GLIDE });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `selectedChassisFlowCentre` is rebuilt fresh every render; listing it would fire this on every pixel of a pan or scroll.
  }, [configDrawerOpen, selectedChassis?.id, rf]);

  const insideOpen = insideStopContent != null;
  useEffect(() => {
    if (!insideOpen || selectedChassisFlowCentre == null) return;
    void rf.setCenter(selectedChassisFlowCentre.x, selectedChassisFlowCentre.y, { zoom: CAMERA_STOPS.inside / 100, ...GLIDE });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- as the drawer effect above: the centre is rebuilt every render.
  }, [insideOpen, selectedChassis?.id, rf]);

  // The camera follows the bar's zoom: about the chassis above an open drawer,
  // else about the pane centre. A person's own move reports its zoom at its end.
  useEffect(() => {
    if (personMovingRef.current) return;
    const live = rf.getViewport();
    if (Math.round(live.zoom * 100) === zoom) return;
    const nextZoom = zoom / 100;
    const pane = containerRef.current;
    const target = configDrawerOpen && selectedChassisFlowCentre != null ? centreAboveDrawer(selectedChassisFlowCentre, nextZoom, pane) : null;
    if (target != null) void rf.setCenter(target.x, target.y, { zoom: nextZoom });
    else void rf.setViewport(pane == null ? { ...live, zoom: nextZoom } : zoomAboutPaneCentre(live, nextZoom, pane.clientWidth, pane.clientHeight));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the bar alone; the drawer and chassis are read as they are now.
  }, [zoom, rf]);

  // Pans the camera to the selected port's own owning box at the faceplate
  // stop (`buildDrawingNodes.ts` resolves which box that is).
  const selectedPortId = selected?.kind === 'port' ? selected.id : null;
  useEffect(() => {
    if (selectedPortId == null || selectedPortOwnerCentre == null) return;
    void rf.setCenter(selectedPortOwnerCentre.x, selectedPortOwnerCentre.y, { zoom: CAMERA_STOPS.faceplate / 100, ...GLIDE });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `selectedPortOwnerCentre` is rebuilt fresh every render, the same reasoning as above.
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

  // Each plate's own port layout (`faceplate.ts`), so a cable can start at
  // its port's edge. A power inlet that routes to a rail or anchor has no box.
  const plates = new Map<string, { x: number; y: number; node: RFNode }>();
  for (const n of nodes) if (n.type === 'chassis') plates.set((n.data as ChassisNodeData).chassis.id, { x: n.position.x, y: n.position.y, node: n });
  function portBox(end: { portId: string; chassisId: string }): PortPoint | null {
    const plate = plates.get(end.chassisId);
    if (plate == null) return null;
    const data = plate.node.data as ChassisNodeData;
    const found = findAnyPort(view, end.portId);
    if (found?.isPsuInlet && powerLeadHandle(elevationFor(found.rack.id), cameraStop) !== 'inlet') return null;
    const items = plateItems(data.ports, data.inlets, data.elevation);
    const box = faceplateLayoutFor(items, data.chassis.heightU, data.chassis.hostname || UNNAMED_HOSTNAME).byId.get(end.portId);
    return box == null ? null : { x: plate.x + box.x, y: plate.y + box.y, w: box.w, h: box.h, row: box.row };
  }
  type RealEnd = { portId: string; chassisId: string; rackId: string | null };
  // Where a planned cable's end lands: the node and handle a real cable to that port would use.
  const resolvePlanPort = (portId: string): PortTarget | null => {
    const at = locatePort(view, portId);
    if (at == null) return null;
    const end: RealEnd = at.place === 'chassis' ? { portId, chassisId: at.chassis.id, rackId: at.rack.id } : { portId, chassisId: '', rackId: null };
    const target = resolveEnd(end);
    return target == null ? null : { ...target, box: portBox(end) };
  };
  const realEndsOf = (cable: CableView): RealEnd[] => cable.ends.filter((e): e is RealEnd => 'portId' in e);

  // Far-apart cables draw as stubs with a tag naming the far end (ADR-0061 round 7).
  const chassisInfo = new Map<string, { hostname: string; rackLabel: string | null }>();
  for (const rack of view.racks) for (const c of rack.chassis) chassisInfo.set(c.id, { hostname: c.hostname, rackLabel: rack.label });
  const centreOf = (b: PortPoint): { x: number; y: number } => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const stubbed = stubbedRef.current;
  function stubFor(key: string, a: RealEnd, b: RealEnd, pa: PortPoint | null, pb: PortPoint | null, count = 1): [StubEnd, StubEnd] | undefined {
    if (pa == null || pb == null) return undefined;
    const was = stubbed.has(key);
    const off = endOffScreen(centreOf(pa), settled.rect, settled.zoom, was) || endOffScreen(centreOf(pb), settled.rect, settled.zoom, was);
    if (off) stubbed.add(key);
    else stubbed.delete(key);
    if (!off) return undefined;
    // The stub at `own` names the far end `far`, and clears `own`'s rack frame.
    const tag = (far: RealEnd, own: RealEnd): StubEnd => {
      const info = chassisInfo.get(far.chassisId);
      const rack = own.rackId != null ? rf.getInternalNode(rackNodeId(own.rackId)) : undefined;
      const y = rack?.internals.positionAbsolute.y;
      const frame = y != null && rack?.measured.height != null ? { top: y, bottom: y + rack.measured.height } : undefined;
      return { text: stubTagText(info?.hostname ?? '', info?.rackLabel ?? null, count), panTo: far.chassisId, frame };
    };
    return [tag(b, a), tag(a, b)];
  }
  const handlePanTo = (chassisId: string) => {
    const n = rf.getInternalNode(chassisNodeId(chassisId));
    if (n == null) return;
    void rf.setCenter(n.internals.positionAbsolute.x + (n.measured.width ?? RACK_INNER_PX) / 2, n.internals.positionAbsolute.y + (n.measured.height ?? U_PX) / 2, { zoom: rf.getZoom(), ...GLIDE });
  };

  // Close in, every cable is its own line with each end's port named; the
  // labels are packed so none overlaps another.
  const endLabels = new Map<string, { text: string; dx: number; dy: number }>();
  if (splitBundles) {
    const items: LabelItem[] = [];
    for (const cable of drawnCables) {
      const real = realEndsOf(cable);
      if (real.length !== 2) continue;
      const boxes = [portBox(real[0]!), portBox(real[1]!)] as const;
      if (boxes[0] == null || boxes[1] == null) continue;
      const leads = leadsFor(boxes[0], boxes[1], { x: 0, y: 0 }, { x: 0, y: 0 });
      [leads.a, leads.b].forEach((lead, i) =>
        items.push({ key: `${cable.id}:${i}`, x: lead.x, y: lead.y, dir: lead.dir, text: portLabel(real[i]!.portId) }),
      );
    }
    const placed = placeLabels(items, 10 / (zoomBand / 100));
    for (const item of items) {
      const at = placed.get(item.key);
      if (at != null) endLabels.set(item.key, { text: item.text, ...at });
    }
  }

  // UI-SPEC "Keeping it readable at forty cables" #1: cables sharing both
  // ends (and the same lane/kind, `bundles.ts`'s own doc) draw as one band.
  // Decision 7 — "Bundles and the lit path count only drawn cables": built
  // off `drawnCables`, never the full `view.cables`, so a bundle with every
  // member hidden or filtered out is a bundle nobody should see either.
  const bundles = useMemo(() => groupBundles(drawnCables), [drawnCables]);

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

    const boxes: [PortPoint | null, PortPoint | null] = [portBox(real[0]!), real.length === 2 ? portBox(real[1]!) : null];
    const l0 = endLabels.get(`${cable.id}:0`);
    const l1 = endLabels.get(`${cable.id}:1`);
    const edgeData: CableEdgeData = {
      cable,
      onSelect: (cableId: string) => onSelect({ kind: 'cable', id: cableId }),
      onHoverChange: handleHoverCable,
      portPairLabel,
      ends: boxes[0] != null || boxes[1] != null ? boxes : undefined,
      endLabels: l0 != null && l1 != null ? [l0, l1] : undefined,
      stub: real.length === 2 ? stubFor(cable.id, real[0]!, real[1]!, boxes[0], boxes[1]) : undefined,
      onPanTo: handlePanTo,
      dashed: dashedCableIds?.has(cable.id) ?? false,
    };
    return {
      id: cable.id,
      type: 'cable',
      source: source.nodeId,
      sourceHandle: source.handleId,
      target: target.nodeId,
      targetHandle: target.handleId,
      selectable: false, // selection is handled by CableEdge's own onClick, not React Flow's
      // Below a chassis's own `zIndex: 10`: names and ports draw above
      // cables, so pressing a port always starts a new cable.
      zIndex: 5,
      data: edgeData,
    } satisfies CableEdgeType;
  }

  function stubForBundle(bundle: Bundle, pa: PortPoint | null, pb: PortPoint | null): [StubEnd, StubEnd] | undefined {
    const m = realEndsOf(bundle.members[0]!);
    const a = m.find((e) => e.chassisId === bundle.chassisA);
    const b = m.find((e) => e.chassisId === bundle.chassisB);
    return a != null && b != null ? stubFor(bundle.key, a, b, pa, pb, bundle.members.length) : undefined;
  }

  const edges: Edge[] = [];
  const bundledCableIds = new Set(splitBundles ? [] : bundles.filter((b) => b.members.length > 1).flatMap((b) => b.members.map((m) => m.id)));

  for (const bundle of splitBundles ? [] : bundles) {
    if (bundle.members.length === 1) continue; // a bundle of one is a plain cable, handled below
    const fanned = fannedBundleKey === bundle.key;
    // The band runs between the average of each side's own ports, not the device edge.
    const side = (chassisId: string): PortPoint | null => {
      const boxes = bundle.members
        .flatMap((m) => realEndsOf(m).filter((e) => e.chassisId === chassisId))
        .map(portBox)
        .filter((b): b is PortPoint => b != null);
      if (boxes.length === 0) return null;
      const mean = (f: (b: PortPoint) => number) => boxes.reduce((n, b) => n + f(b), 0) / boxes.length;
      return { x: mean((b) => b.x), y: mean((b) => b.y), w: mean((b) => b.w), h: mean((b) => b.h) };
    };
    const bundleData: BundleEdgeData = {
      bundle,
      fanned,
      onFan: setFannedBundleKey,
      ends: [side(bundle.chassisA), side(bundle.chassisB)],
      stub: stubForBundle(bundle, side(bundle.chassisA), side(bundle.chassisB)),
      onPanTo: handlePanTo,
    };
    edges.push({
      id: `bundle:${bundle.key}`,
      type: 'bundle',
      source: chassisNodeId(bundle.chassisA),
      sourceHandle: '__bundle__',
      target: chassisNodeId(bundle.chassisB),
      targetHandle: '__bundle__',
      selectable: false,
      zIndex: 5,
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

  for (const cable of drawnCables) {
    if (bundledCableIds.has(cable.id)) continue; // drawn above, as the bundle's band and (when fanned) its members
    const built = buildCableEdge(cable);
    if (built) edges.push(built);
  }

  const handleNodeClick: NodeMouseHandler = useCallback(
    (event, node) => {
      if (free.onNodeClick(event, node)) return;
      const parsed = parseNodeId(node.id);
      if (parsed == null) return;
      onSelect(parsed.kind === 'rack' ? { kind: 'rack', id: parsed.id } : { kind: 'chassis', id: parsed.id });
      const name = parsed.kind === 'chassis' ? (event.target as Element).closest('.drawing-chassis__hostname') : null;
      if (name == null) {
        setCallout(null);
        return;
      }
      const r = name.getBoundingClientRect();
      const a = rf.screenToFlowPosition({ x: r.left, y: r.top + r.height / 2 });
      const b = rf.screenToFlowPosition({ x: r.right, y: r.top + r.height / 2 });
      setCallout({ id: parsed.id, left: a.x, right: b.x, y: a.y });
    },
    [onSelect, rf, free.onNodeClick],
  );

  const handleNodeDoubleClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      const freeBox = parseFreeNodeId(node.id);
      if (freeBox?.kind === 'box' && onOpenDevice) return openChassis(freeBox.id);
      if (free.onNodeDoubleClick(node)) return;
      const parsed = parseNodeId(node.id);
      if (parsed?.kind === 'chassis') openChassis(parsed.id);
    },
    [openChassis, onOpenDevice, free.onNodeDoubleClick],
  );

  const chassisHeightUFor = (node: FlowNode): number =>
    node.type === 'chassis' ? (node.data as ChassisNodeData).chassis.heightU : 1;

  const handleNodeDragStart: OnNodeDrag = useCallback((_event, node, dragged) => void free.onNodeDragStart(node, dragged), [free.onNodeDragStart]);

  const handleNodeDrag: OnNodeDrag = useCallback(
    (_event, node, dragged) => {
      if (free.onNodeDrag(node, dragged)) return;
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
    [view.racks, rackPositions, free.onNodeDrag],
  );

  const handleNodeDragStop: OnNodeDrag = useCallback(
    (_event, node) => {
      if (free.onNodeDragStop(node)) return;
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
    [view.racks, rackPositions, onMove, triggerShake, free.onNodeDragStop],
  );

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!canDraw) return; // ADR-0052 §5: a reader's palette drop is refused, not merely ignored on drop
      if (!event.dataTransfer.types.includes(PALETTE_DRAG_MIME)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      // Light the unit the item would land in (the size is only known from the drag start).
      const heightU = getDraggedUnits();
      const rack =
        heightU == null
          ? null
          : rackAtPoint<RackView>(view.racks, rackPositions, rf.screenToFlowPosition({ x: event.clientX, y: event.clientY }), RACK_NODE_WIDTH);
      if (heightU == null || rack == null) {
        setDropPreview((prev) => (Object.keys(prev).length === 0 ? prev : {}));
        return;
      }
      const y = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY }).y;
      const positionU = snapDropToU(rack.heightU, y - rackPositions[rack.id].y - RACK_HEADER_PX, heightU);
      const next = { fromU: positionU, toU: positionU + heightU - 1, valid: !overlapsRack(rack, { positionU, heightU }) };
      setDropPreview((prev) => {
        const cur = prev[rack.id];
        return cur && cur.fromU === next.fromU && cur.toU === next.toU && cur.valid === next.valid ? prev : { [rack.id]: next };
      });
    },
    [canDraw, rf, view.racks, rackPositions],
  );

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropPreview((prev) => (Object.keys(prev).length === 0 ? prev : {}));
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!canDraw) return; // ADR-0052 §5: no placement for a reader, even if a drop event somehow reaches here
      setDropPreview({});
      const raw = event.dataTransfer.getData(PALETTE_DRAG_MIME);
      if (!raw) return;
      event.preventDefault();
      const payload = decodePaletteDrag(raw);
      if (payload == null) return;

      const flowPoint = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const rack = rackAtPoint<RackView>(view.racks, rackPositions, flowPoint, RACK_NODE_WIDTH);
      if (rack == null) {
        free.dropBox(payload.role ?? null, flowPoint);
        return;
      }
      const rackPos = rackPositions[rack.id];
      const offsetFromTop = flowPoint.y - rackPos.y - RACK_HEADER_PX;
      const positionU = snapDropToU(rack.heightU, offsetFromTop, payload.rackUnits);
      if (overlapsRack(rack, { positionU, heightU: payload.rackUnits })) {
        triggerShake(rackNodeId(rack.id));
        return;
      }
      onPlace(rack.id, { vendor: payload.vendor, model: payload.model, role: payload.role }, positionU);
    },
    [rf, view.racks, rackPositions, onPlace, triggerShake, canDraw, free.dropBox],
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
      const fromHandleId = connectionState.fromHandle?.id;
      if (!connectionState.isValid) {
        if (toHandleId != null) triggerPortShake(toHandleId);
        // Checks: say why the drop could not work (the card, at the pointer).
        if (toHandleId != null && fromHandleId && fromHandleId !== toHandleId) checks?.guardCable(fromHandleId, toHandleId, mediaCandidates(view, fromHandleId, toHandleId));
        return;
      }
      if (!fromHandleId || !toHandleId) return;
      // Checks: a refused cable is never drawn; a failure of the checks themselves is a pass.
      if (checks?.guardCable(fromHandleId, toHandleId, mediaCandidates(view, fromHandleId, toHandleId))) return;
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
    [view, triggerPortShake, checks],
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
      if (free.onKeyDown(event)) return;
      if (event.key === 'Escape' && !event.defaultPrevented && !focusIsInAField()) {
        if (openedRef.current != null) setOpened(null);
        else if (selected != null || calloutRef.current != null) onSelect(null);
        return;
      }
      if (!canDraw) return; // ADR-0052 §5: a reader deletes nothing, undoes nothing
      if ((event.key === 'z' || event.key === 'Z') && (event.ctrlKey || event.metaKey)) {
        if (focusIsInAField()) return;
        event.preventDefault();
        if (event.shiftKey) onRedo?.();
        else onUndo?.();
        return;
      }
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (focusIsInAField()) return;
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
  }, [selected, onSelect, onDisconnect, onRemoveDevice, canDraw, onUndo, onRedo, view, free.onKeyDown]);

  // `useLayoutEffect`, not `useEffect` — commits before the browser paints, so a node subscribed to one of these never draws one frame stale.
  useLayoutEffect(() => {
    liveStore.setState({
      selected,
      dragFromPortId,
      livePortIds: livePortIds ?? EMPTY_STRING_SET,
      dropPreview,
      shakingRackId: shakingId,
      dimmedChassisId,
      cameraStop,
      showPortGlyphs,
      splitBundles,
    });
  }, [liveStore, selected, dragFromPortId, livePortIds, dropPreview, shakingId, dimmedChassisId, cameraStop, showPortGlyphs, splitBundles]);

  const allNodes = useMemo(() => [...nodes, ...free.nodes], [nodes, free.nodes]);
  const marks = useMemo(
    () =>
      peerMarks(allNodes, peers ?? [], (id) => {
        const owner = ownerNodeIdForPort(view, id);
        return [chassisNodeId(id), rackNodeId(id), shelfNodeId(id), surfaceNodeId(id), ...(owner != null ? [owner] : [])];
      }),
    [allNodes, peers, view],
  );
  const allEdges = useMemo(() => [...edges, ...free.edges], [edges, free.edges]);
  // An open plan's marks and focus first; a Checks Show then fades on top and wins.
  const planned = usePlansFade(allNodes, allEdges, resolvePlanPort);
  const shown = useChecksFade(planned.nodes, planned.edges);

  return (
    <LiveStoreProvider value={liveStore}>
    <LiveLitPath view={view} portalGroups={portalGroups} selected={selected} liveStore={liveStore} drawnCableIds={drawnCableIds} />
    <div
      className="drawing"
      ref={containerRef}
      data-camera-stop={cameraStop}
      data-zoom-band={zoomBand}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      {...free.containerProps}
    >
      <ReactFlow
        nodes={shown.nodes}
        edges={shown.edges}
        nodeTypes={ALL_NODE_TYPES}
        edgeTypes={ALL_EDGE_TYPES}
        defaultViewport={defaultViewport}
        onMoveStart={handleMoveStart}
        onMove={handleMove}
        onMoveEnd={handleMoveEnd}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onPaneClick={() => {
          if (!free.onPaneClick()) onSelect(null);
        }}
        onNodeDragStart={handleNodeDragStart}
        onNodeContextMenu={handleNodeContextMenu}
        onEdgeContextMenu={handleEdgeContextMenu}
        onPaneContextMenu={handlePaneContextMenu}
        proOptions={PRO_OPTIONS}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        // Left-drag on empty canvas pans (Shift+drag is the marquee); the middle button, Space+drag, the wheel or a trackpad pan too (pinch zooms).
        panOnDrag={tool === 'pan' ? PAN_BUTTONS : MIDDLE_ONLY}
        panActivationKeyCode="Space"
        panOnScroll={wheel === 'scroll'}
        zoomOnScroll={wheel === 'zoom'}
        zoomOnPinch
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
        {free.portal}
        {marks.length > 0 && (
          <ViewportPortal>
            {marks.map((m) => (
              <div
                key={m.account}
                className="drawing-peer"
                style={{ transform: `translate(${m.x}px, ${m.y}px)`, width: PEER_DOT_PX, height: PEER_DOT_PX }}
                role="img"
                aria-label={`${m.name} has this selected`}
                title={m.name}
              >
                {m.initials}
              </div>
            ))}
          </ViewportPortal>
        )}
      </ReactFlow>
      {free.overlay}
      <CanvasTools tool={tool} onTool={setTool} wheel={wheel} onWheel={setWheel} />
      <ChecksCanvasBridge />
      <PlansCanvasBridge />
      {selectedChassis != null && callout?.id === selectedChassis.id && opened == null && calloutRack != null ? (
        <Callout
          chassis={selectedChassis}
          rackLabel={calloutRack.label}
          plate={callout}
          rack={{ left: rackPositions[calloutRack.id]?.x ?? 0, right: (rackPositions[calloutRack.id]?.x ?? 0) + RACK_NODE_WIDTH }}
          paneWidth={containerRef.current?.clientWidth ?? Infinity}
          onOpen={() => openChassis(selectedChassis.id)}
          onDetails={() => setCallout(null)}
        />
      ) : null}
      {emptyHint ? (
        <p className="drawing-empty-hint" role="note">
          {emptyHint}
        </p>
      ) : null}
      {menu ? (
        <ContextMenu
          key={`${menu.x},${menu.y}`}
          x={menu.x}
          y={menu.y}
          items={menuItemsFor(menu.target, menuActions)}
          onClose={closeMenu}
        />
      ) : null}
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
