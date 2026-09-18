import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
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
import type { CableKind, CableView, ClosetView, DrawingActions, RackView, RowView, Selection, Sheath } from './contract';
import { decodePaletteDrag, PALETTE_DRAG_MIME } from './dnd';
import {
  CAMERA_STOPS,
  RACK_HEADER_PX,
  RACK_INNER_PX,
  RAIL_PX,
  U_PX,
  cableSagPath,
  cameraStopAt,
  overlapsRack,
  portOpacity as portOpacityAt,
  rackAtPoint,
  snapDropToU,
  uToOffsetPx,
} from './geometry';
import { ChassisNode, INLET_ANCHOR_HANDLE_ID, type ChassisNodeData, type ChassisNodeType } from './ChassisNode';
import { BundleEdge, type BundleEdgeData, type BundleEdgeType } from './BundleEdge';
import { CableEdge, type CableEdgeData, type CableEdgeType } from './CableEdge';
import { ColourPicker } from './ColourPicker';
import { RACK_NODE_WIDTH, RackNode, rackNodeHeight, type RackNodeData, type RackNodeType } from './RackNode';
import { PortalTrayNode, PORTAL_TRAY_HEIGHT, type PortalTrayNodeData, type PortalTrayNodeType } from './PortalTrayNode';
import { ROW_LABEL_WIDTH, RowLabelNode, type RowLabelNodeData, type RowLabelNodeType } from './RowLabelNode';
import { SurfaceNode, type SurfaceNodeData, type SurfaceNodeType } from './SurfaceNode';
import { chassisNodeId, parseNodeId, rackNodeId, rowLabelNodeId, surfaceNodeId, trayNodeId } from './nodeId';
import { findAnyPort, locatePort } from './lookup';
import { liveTargetPortIds } from './liveTargets';
import { groupPortals, portalCountLabel } from './portals';
import { sheathsFor } from './sheath';
import { groupBundles } from './bundles';
import { litPathFor } from './paths';
import { faceplateItems, powerLeadHandle, type Facing } from './elevation';
import { layoutRow, layoutSurfaces, mirroredRackX, rowKey, type RowLayout } from './rows';

const NODE_TYPES = {
  rack: RackNode,
  chassis: ChassisNode,
  tray: PortalTrayNode,
  rowLabel: RowLabelNode,
  surface: SurfaceNode,
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
type AnyTrayNode = PortalTrayNodeType;
type FlowNode = AnyRackNode | AnyChassisNode | AnyTrayNode | RowLabelNodeType | SurfaceNodeType;

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
  onPlace,
  onMove,
  onSelect,
  onConnect,
  onDisconnect,
}: DrawingProps) {
  const rf = useReactFlow<FlowNode>();

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
  const [dragOverride, setDragOverride] = useState<Record<string, { x: number; y: number }>>({});
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

  // UI-SPEC "Cables": "the port a cable fills takes the sheath colour" —
  // built once per view change rather than have every `ChassisNode` search
  // the whole cable list for its own ports.
  const portSheath = useMemo(() => {
    const map = new Map<string, Sheath>();
    for (const cable of view.cables ?? []) {
      if (cable.sheath == null) continue;
      for (const end of cable.ends) {
        if ('portId' in end) map.set(end.portId, cable.sheath);
      }
    }
    return map;
  }, [view.cables]);

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
  // here runs merely because `dragOverride`/`rackPositions` changed); it is
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
    // paragraph above already gives `dragOverride`/`rackPositions`: a drag
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

  const nodes: Node[] = [];

  rowLayouts.forEach((layout, rowIndex) => {
    const y = rowBandY(rowLayouts, rowIndex);
    if (cameraStop === 'closet' && layout.racks.length > 0) {
      const key = rowKey(rowViews[rowIndex]!, rowIndex);
      const bandHeight = Math.max(0, ...layout.racks.map((r) => rackNodeHeight(r)));
      const rowLabelData: RowLabelNodeData = {
        label: layout.label,
        elevation: layout.elevation,
        onFlip: () => setRowFacing((prev) => ({ ...prev, [key]: prev[key] === 'rear' ? 'front' : 'rear' })),
      };
      nodes.push({
        id: rowLabelNodeId(key),
        type: 'rowLabel',
        position: { x: -(ROW_LABEL_WIDTH + RACK_GAP_PX / 2), y },
        draggable: false,
        selectable: false,
        style: { width: ROW_LABEL_WIDTH, height: bandHeight },
        data: rowLabelData,
      } satisfies RowLabelNodeType);
    }

    for (const rack of layout.racks) {
      const pos = rackPositions[rack.id] ?? { x: 0, y };
      const elevation = elevationFor(rack.id);
      // ADR-0050 §1: every mounted chassis draws at every elevation now —
      // as its own faceplate for this face, or a plain plate when it has
      // none — so this is no longer a filtered subset the way the retired
      // `faces.ts`'s `chassisToDraw` was.
      const items = faceplateItems(rack.chassis, elevation);
      const rackData: RackNodeData = {
        rack,
        selected: selected?.kind === 'rack' && selected.id === rack.id,
        dropPreview: dropPreview[rack.id] ?? null,
        shaking: shakingId === rackNodeId(rack.id),
        chassisItems: items,
        elevation,
        onFlip: () => setRackFacing((prev) => ({ ...prev, [rack.id]: prev[rack.id] === 'rear' ? 'front' : 'rear' })),
        showFlip: cameraStop === 'rack',
        // s6f #2: reuses `setHoveredCableId` itself — the exact function a
        // `CableEdge`'s own `onHoverChange` already calls — so a rail
        // hexagon's hover and a cable's own hover write the same state.
        onHoverInlet: setHoveredCableId,
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

      for (const item of items) {
        const { chassis } = item;
        const id = chassisNodeId(chassis.id);
        const basePosition = {
          x: pos.x + RAIL_PX,
          y: pos.y + RACK_HEADER_PX + uToOffsetPx(rack.heightU, chassis.positionU, chassis.heightU),
        };
        const chassisData: ChassisNodeData = {
          chassis,
          ports: item.ports,
          inlets: item.inlets,
          elevation,
          selected: selected?.kind === 'chassis' && selected.id === chassis.id,
          portOpacity: portOpacityAt(zoomPercent),
          onSelectPort: (portId: string) => onSelect({ kind: 'port', id: portId }),
          liveDrag: dragFromPortId ? { fromPortId: dragFromPortId, livePortIds: livePortIds ?? new Set() } : null,
          portSheath,
          // s6f #2: "the same hover key" as the rail hexagon's own
          // `onHoverInlet` (`RackNodeData`, above) — an inlet glyph in the
          // strip compares its own cable against this to light or dim.
          litCableId,
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
  });

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
    const surfaceData: SurfaceNodeData = {
      placement,
      uPx: U_PX,
      onSelectPort: (portId: string) => onSelect({ kind: 'port', id: portId }),
      liveDrag: dragFromPortId ? { fromPortId: dragFromPortId, livePortIds: livePortIds ?? new Set() } : null,
      portSheath,
      litCableId,
      portOpacity: portOpacityAt(zoomPercent),
    };
    nodes.push({
      id: surfaceNodeId(placement.surface.id),
      type: 'surface',
      position: { x: placement.x, y: placement.y },
      draggable: false,
      selectable: false,
      style: { width: placement.widthPx, height: placement.heightPx },
      data: surfaceData,
    } satisfies SurfaceNodeType);
  }

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
    const trayData: PortalTrayNodeData = {
      label: group.label,
      countLabel: portalCountLabel(group),
      side: group.side,
      lit: litTrayKeySet.has(group.key),
    };
    nodes.push({
      id: trayNodeId(group.key),
      type: 'tray',
      position: { x: pos.x, y },
      draggable: false,
      selectable: false,
      style: { width: RACK_NODE_WIDTH, height: PORTAL_TRAY_HEIGHT },
      data: trayData,
    } satisfies AnyTrayNode);
  }

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
  function resolveEnd(end: { portId: string; chassisId: string; rackId: string }): { nodeId: string; handleId: string } | null {
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
    // ADR-0051 §1: a `CableEnd` this drawing does not carry a rack chassis
    // for — a shelf occupant's own port or a surface fixture's — resolved
    // the same way `lookup.ts`'s own file header names: "as it does chassis
    // ports." A shelf occupant has no React Flow node of its own yet (no
    // `ShelfPlate` is mounted by this component), so that place resolves to
    // nothing there is a real node for; a fixture's own port routes straight
    // to its surface's one node (`surfaceNodeId`), under the SAME port id
    // `SurfaceNode.tsx` renders a real `Handle` for.
    const location = locatePort(view, end.portId);
    if (location?.place === 'fixture') return { nodeId: surfaceNodeId(location.surface.id), handleId: end.portId };
    return null;
  }

  function portLabel(portId: string): string {
    return locatePort(view, portId)?.port.label || portId;
  }

  // UI-SPEC "Keeping it readable at forty cables" #1: cables sharing both
  // ends (and the same lane/kind, `bundles.ts`'s own doc) draw as one band.
  const bundles = useMemo(() => groupBundles(view.cables ?? []), [view.cables]);

  function buildCableEdge(cable: CableView, portPairLabel?: string): CableEdgeType | null {
    const real = cable.ends.filter((e): e is { portId: string; chassisId: string; rackId: string } => 'portId' in e);
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
        const real = member.ends.filter((e): e is { portId: string; chassisId: string; rackId: string } => 'portId' in e);
        const label = real.length === 2 ? `${portLabel(real[0].portId)} ↔ ${portLabel(real[1].portId)}` : undefined;
        const built = buildCableEdge(member, label);
        if (built) edges.push(built);
      }
    }
  }

  for (const cable of view.cables ?? []) {
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
        // s6f #3: once a person has placed this rack by hand, the row-flip
        // layout effect (above) stops snapping it to a freshly computed bay
        // slot and mirrors its own position instead.
        setDraggedRackIds((prev) => (prev.has(parsed.id) ? prev : new Set(prev).add(parsed.id)));
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

  // UI-SPEC "Drag-to-connect": "the lead droops live between the fixed
  // port and the pointer; only ports compatible with the origin stay
  // live... a port that already has a cable is never a target."
  const isValidConnection: IsValidConnection = useCallback(
    (edgeOrConnection) => {
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
    [view],
  );

  const handleConnectStart: OnConnectStart = useCallback((_event, params) => {
    setDragFromPortId(params.handleId ?? null);
  }, []);

  // UI-SPEC "Drag-to-connect": "drop on a live port opens the colour
  // picker... drop anywhere else, or Escape, cancels with nothing
  // recorded." A drop that lands on an incompatible or already-cabled port
  // is simply not `isValid` — `connectionState.isValid` reflects
  // `isValidConnection` above — so it falls through to the same "nothing
  // recorded" path as a drop on empty canvas, per the brief's build list
  // (no separate shake is specified for a cable drop, unlike a chassis
  // drop's `overlapsRack` shake above).
  const handleConnectEnd: OnConnectEnd = useCallback(
    (_event, connectionState: FinalConnectionState) => {
      setDragFromPortId(null);
      if (!connectionState.isValid) return;
      const fromHandleId = connectionState.fromHandle?.id;
      const toHandleId = connectionState.toHandle?.id;
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
    [view],
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
  // nothing else — no confirmation dialog; undo is the record's job."
  // React Flow's own delete handling stays off (`deleteKeyCode={null}`
  // below, unchanged from before this session) for racks and chassis,
  // which do not have a delete feature yet — this listener acts only when
  // a cable is the current selection.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (selected?.kind !== 'cable') return;
      event.preventDefault();
      onDisconnect?.(selected.id);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selected, onDisconnect]);

  return (
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
        minZoom={CAMERA_STOPS.closet / 100 - 0.1}
        maxZoom={CAMERA_STOPS.faceplate / 100 + 0.3}
        panOnDrag
        panOnScroll={false}
        zoomOnScroll
        // UI-SPEC "Cables": a drag may be picked up from either end of a
        // future cable, and dropped on any other live port — loose mode is
        // what lets every port `Handle` (all declared `type="source"`,
        // `ChassisNode.tsx`) both start and receive a connection.
        connectionMode={ConnectionMode.Loose}
        connectionLineComponent={ConnectionLine}
        isValidConnection={isValidConnection}
        onConnectStart={handleConnectStart}
        onConnectEnd={handleConnectEnd}
        nodesConnectable
        elementsSelectable
        deleteKeyCode={null}
      >
        <Background gap={U_PX} size={1} />
      </ReactFlow>
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
