// The free layer of the canvas (ADR-0060 step 7): boxes, lines, labels and areas beside the racks,
// with edge squares, the word menu, marquee, guides, nudge and copy/paste. `Drawing.tsx` mounts
// this and asks it first about every click, drag and key; what it does not own it leaves alone.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react';
import { ViewportPortal, useViewport, type Node as RFNode, type Edge as RFEdge, type ReactFlowInstance } from '@xyflow/react';

import '../../styles/free.css';
import '../../styles/multiPanel.css';
import { AREA_DEFAULT_H, AREA_DEFAULT_W, AREA_MIN_H, AREA_MIN_W } from '../../document/freeform';
import type { ClosetView, DrawingActions, Selection } from './contract';
import { ContextMenu } from './ContextMenu';
import { FreeBoxNode, type FreeBoxNodeData } from './FreeBoxNode';
import {
  BOX_H,
  BOX_KINDS,
  BOX_W,
  alignRects,
  boundsOf,
  centreOf,
  contains,
  estimateLabelSize,
  freeNodeId,
  ghostSpot,
  groupRect,
  guidesFor,
  labelNodeId,
  lineEdgeId,
  lineSides,
  overlaps,
  parseFreeNodeId,
  rectFromPoints,
  sidePoint,
  spreadRects,
  type AlignMode,
  type Guides,
  type Rect,
  type Side,
} from './freeLayout';
import { LabelNode, type LabelNodeData } from './LabelNode';
import { LineEdge, type LineEdgeData } from './LineEdge';
import { parseNodeId } from './nodeId';
import type { GripDrag } from './useGripDrag';
import { WordMenu } from './WordMenu';

export const FREE_NODE_TYPES = { freeBox: FreeBoxNode, label: LabelNode };
export const FREE_EDGE_TYPES = { line: LineEdge };

type Point = { x: number; y: number };

/** Where the next added box goes, and what it joins. Screen coordinates are the drawing's own pixels. */
interface Pending {
  screen: Point;
  flow: Point;
  /** The box the new one is joined to by a line, if any. */
  fromBoxId?: string;
  /** Set when the box goes into a free unit of a rack instead of onto the canvas. */
  rack?: { rackId: string; positionU: number };
}

export type FreeActions = Pick<
  DrawingActions,
  'onAddFreeBox' | 'onAddDeviceAt' | 'onMoveFree' | 'onConnectBoxes' | 'onAddLabel' | 'onSetLabel' | 'onRemoveFree' | 'onDuplicateFree' | 'onAddFreeBoxFromTemplate'
>;

/** The camera helpers the free layer uses; none depends on the node type. */
export type RF = Pick<ReactFlowInstance, 'flowToScreenPosition' | 'screenToFlowPosition' | 'getZoom' | 'getInternalNode'>;

export interface FreeLayerArgs {
  view: ClosetView;
  canDraw: boolean;
  rf: RF;
  containerRef: RefObject<HTMLDivElement | null>;
  selected: Selection | null;
  onSelect: (selection: Selection | null) => void;
  actions: FreeActions;
  /** What a plain left-drag on empty canvas does: pan the view, or draw a selection box (Shift always draws one). */
  tool?: 'pan' | 'select';
  /** Saved faceplates a new box may start from (this person's, in this browser). */
  templates?: readonly { id: string; name: string }[];
}

const NUDGE = 4;
const NUDGE_BIG = 32;
const PASTE_STEP = 24;
const NUDGE_FLUSH_MS = 400;
const GUIDE_PX = 6;

const idOf = (nodeId: string): string => parseFreeNodeId(nodeId)?.id ?? nodeId;

export interface FreeLayer {
  nodes: RFNode[];
  edges: RFEdge[];
  /** Every free node's id, for fitting the camera. */
  fitIds: { id: string }[];
  /** What a free layer wants over and beside the canvas. */
  portal: ReactNode;
  overlay: ReactNode;
  /** Each returns true when the free layer took the event. */
  onNodeClick: (event: { shiftKey: boolean }, node: RFNode) => boolean;
  onNodeDoubleClick: (node: RFNode) => boolean;
  onNodeDragStart: (node: RFNode, dragged: RFNode[]) => boolean;
  onNodeDrag: (node: RFNode, dragged: RFNode[]) => boolean;
  onNodeDragStop: (node: RFNode) => boolean;
  onPaneClick: () => boolean;
  onKeyDown: (event: KeyboardEvent) => boolean;
  /** A palette item dropped on empty canvas becomes a free box. */
  dropBox: (role: string | null, flow: Point, model?: { vendor: string; model: string }) => void;
  /** Opens the NEW box menu at a point, from a right-click, or the edge square of a racked device. */
  openAdd: (screen: Point, flow: Point, rack?: Pending['rack']) => void;
  addLabelAt: (form: 'text' | 'area' | 'note', flow: Point) => void;
  /** Props for the drawing's own div: marquee on empty canvas. */
  containerProps: { onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void };
  /** Whether the next pane click is the end of a marquee and must be ignored. */
  panModifier: boolean;
  /** True while this layer wants the arrow keys, Delete and Esc. */
  hasSelection: boolean;
  selectedIds: string[];
  removeSelected: () => boolean;
  /** Two or more devices picked together (free boxes and rack-mounted ones), by chassis id; empty otherwise. */
  deviceIds: string[];
  /** Drops the whole multi-selection. */
  clearGroup: () => void;
}

export function useFreeLayer({ view, canDraw, rf, containerRef, selected, onSelect, actions, tool = 'pan', templates = [] }: FreeLayerArgs): FreeLayer {
  const [group, setGroup] = useState<string[]>([]);
  // Rack-mounted devices picked with Shift. They are only ever read for the details panel and the
  // highlight: every move, nudge, align, copy and delete below works on `group` (free nodes) alone.
  const [racked, setRacked] = useState<string[]>([]);
  const [freeDrag, setFreeDrag] = useState<Record<string, Point> | null>(null);
  const [guides, setGuides] = useState<Guides | null>(null);
  const [resizing, setResizing] = useState<{ id: string; w: number; h: number } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [ghostLine, setGhostLine] = useState<{ from: Point; to: Point } | null>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [nudged, setNudged] = useState<Point | null>(null);
  const [lastKind, setLastKind] = useState<string | null>('switch');
  const clipboard = useRef<string[]>([]);
  const pasteCount = useRef(0);
  const dragRef = useRef<{ start: Record<string, Point>; contents: Record<string, string[]>; last: Record<string, Point> } | null>(null);
  const spaceDown = useRef(false);
  const swallowPaneClick = useRef(false);
  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nudgeRef = useRef<Point | null>(null);

  // ---- what is where -------------------------------------------------------

  const boxes = view.free ?? [];
  const labels = view.labels ?? [];
  const lines = view.lines ?? [];
  const boxById = useMemo(() => new Map(boxes.map((b) => [b.id, b])), [boxes]);
  const labelById = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);

  const nodeKey = useCallback((sel: Selection | null): string | null => {
    if (sel?.kind === 'chassis' && boxById.has(sel.id)) return freeNodeId(sel.id);
    if (sel?.kind === 'label' && labelById.has(sel.id)) return labelNodeId(sel.id);
    return null;
  }, [boxById, labelById]);
  const singleNode = nodeKey(selected);
  const selectedIds = useMemo(() => (group.length > 0 ? group : singleNode ? [singleNode] : []), [group, singleNode]);
  const selSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const sizeOf = useCallback(
    (nodeId: string): { w: number; h: number } => {
      const parsed = parseFreeNodeId(nodeId);
      if (parsed?.kind === 'box') return { w: BOX_W, h: BOX_H };
      const label = parsed ? labelById.get(parsed.id) : undefined;
      if (!label) return { w: BOX_W, h: BOX_H };
      if (label.form === 'area') {
        return resizing?.id === nodeId ? { w: resizing.w, h: resizing.h } : { w: label.w, h: label.h };
      }
      const measured = rf.getInternalNode(nodeId)?.measured;
      return measured?.width && measured.height ? { w: measured.width, h: measured.height } : estimateLabelSize(label.text);
    },
    [labelById, resizing, rf],
  );

  const basePos = useCallback(
    (nodeId: string): Point => {
      const parsed = parseFreeNodeId(nodeId);
      const at = parsed?.kind === 'box' ? boxById.get(parsed.id) : parsed ? labelById.get(parsed.id) : undefined;
      return { x: at?.x ?? 0, y: at?.y ?? 0 };
    },
    [boxById, labelById],
  );

  const posOf = useCallback(
    (nodeId: string): Point => {
      const base = basePos(nodeId);
      const live = freeDrag?.[nodeId];
      if (live) return live;
      if (nudged && selSet.has(nodeId)) return { x: base.x + nudged.x, y: base.y + nudged.y };
      return base;
    },
    [basePos, freeDrag, nudged, selSet],
  );

  const rectOf = useCallback((nodeId: string): Rect => ({ ...posOf(nodeId), ...sizeOf(nodeId) }), [posOf, sizeOf]);

  const allNodeIds = useMemo(() => [...labels.map((l) => labelNodeId(l.id)), ...boxes.map((b) => freeNodeId(b.id))], [labels, boxes]);

  // A selection made elsewhere (a click on a rack) ends a group made here.
  useEffect(() => {
    if (selected !== null) {
      setGroup((g) => (g.length > 0 ? [] : g));
      setRacked((r) => (r.length > 0 ? [] : r));
    }
  }, [selected]);

  // Rack-mounted devices that no longer exist drop out too.
  const rackedLive = useMemo(() => new Set(view.racks.flatMap((r) => r.chassis.map((c) => c.id))), [view.racks]);
  useEffect(() => {
    setRacked((r) => {
      const live = r.filter((id) => rackedLive.has(id));
      return live.length === r.length ? r : live;
    });
  }, [rackedLive]);

  // Ids that no longer exist drop out of the group (a removal, an undo).
  useEffect(() => {
    setGroup((g) => {
      const live = g.filter((id) => allNodeIds.includes(id));
      return live.length === g.length ? g : live;
    });
  }, [allNodeIds]);

  const selectOnly = useCallback(
    (nodeId: string) => {
      const parsed = parseFreeNodeId(nodeId);
      if (!parsed) return;
      setGroup([]);
      setRacked([]);
      onSelect(parsed.kind === 'box' ? { kind: 'chassis', id: parsed.id } : { kind: 'label', id: parsed.id });
    },
    [onSelect],
  );

  // `rackedIds` are rack-mounted devices picked along with the free nodes in `ids`.
  const selectMany = useCallback(
    (ids: string[], rackedIds: string[] = []) => {
      if (ids.length + rackedIds.length <= 1) {
        if (ids[0]) selectOnly(ids[0]);
        else if (rackedIds[0]) {
          setGroup([]);
          setRacked([]);
          onSelect({ kind: 'chassis', id: rackedIds[0] });
        } else {
          setGroup([]);
          setRacked([]);
          onSelect(null);
        }
        return;
      }
      setGroup(ids);
      setRacked(rackedIds);
      onSelect(null);
    },
    [onSelect, selectOnly],
  );

  // ---- committing ----------------------------------------------------------

  const commitMoves = useCallback(
    (positions: Record<string, Point>, from: Record<string, Point>) => {
      const moves = Object.entries(positions)
        .filter(([id, p]) => from[id] === undefined || Math.abs(from[id].x - p.x) > 0.01 || Math.abs(from[id].y - p.y) > 0.01)
        .map(([id, p]) => ({ id: idOf(id), x: p.x, y: p.y }));
      if (moves.length > 0) actions.onMoveFree?.(moves);
    },
    [actions],
  );

  const flushNudge = useCallback(() => {
    if (nudgeTimer.current) clearTimeout(nudgeTimer.current);
    nudgeTimer.current = null;
    const total = nudgeRef.current;
    nudgeRef.current = null;
    if (total && (total.x !== 0 || total.y !== 0)) {
      actions.onMoveFree?.(selectedIds.map((id) => ({ id: idOf(id), x: basePos(id).x + total.x, y: basePos(id).y + total.y })));
    }
    setNudged(null);
  }, [actions, selectedIds, basePos]);
  useEffect(() => () => {
    if (nudgeTimer.current) clearTimeout(nudgeTimer.current);
  }, []);

  // ---- adding --------------------------------------------------------------

  const containerPoint = useCallback(
    (client: Point): Point => {
      const rect = containerRef.current?.getBoundingClientRect();
      return { x: client.x - (rect?.left ?? 0), y: client.y - (rect?.top ?? 0) };
    },
    [containerRef],
  );

  const openAdd = useCallback((screen: Point, flow: Point, rack?: Pending['rack']) => {
    if (canDraw) setPending({ screen, flow, rack });
  }, [canDraw]);

  const addBox = useCallback(
    (role: string | null) => {
      const p = pending;
      setPending(null);
      if (!p) return;
      setLastKind(role);
      if (p.rack) {
        actions.onAddDeviceAt?.(p.rack.rackId, p.rack.positionU, role);
        return;
      }
      const made = actions.onAddFreeBox?.(role, p.flow.x, p.flow.y, p.fromBoxId);
      if (typeof made === 'string') selectOnly(freeNodeId(made));
    },
    [pending, actions, selectOnly],
  );

  const addFromTemplate = useCallback(
    (templateId: string) => {
      const p = pending;
      setPending(null);
      if (!p || p.rack) return;
      const made = actions.onAddFreeBoxFromTemplate?.(templateId, p.flow.x, p.flow.y, p.fromBoxId);
      if (typeof made === 'string') selectOnly(freeNodeId(made));
    },
    [pending, actions, selectOnly],
  );

  const dropBox = useCallback(
    (role: string | null, flow: Point, model?: { vendor: string; model: string }) => {
      const made = actions.onAddFreeBox?.(role, flow.x - BOX_W / 2, flow.y - BOX_H / 2, undefined, model);
      if (typeof made === 'string') selectOnly(freeNodeId(made));
    },
    [actions, selectOnly],
  );

  const addLabelAt = useCallback(
    (form: 'text' | 'area' | 'note', flow: Point) => {
      const made = actions.onAddLabel?.(form, form === 'area' ? 'Area' : form === 'note' ? 'Note' : 'Label', flow.x, flow.y, form === 'area' ? AREA_DEFAULT_W : undefined, form === 'area' ? AREA_DEFAULT_H : undefined);
      if (typeof made === 'string') {
        selectOnly(labelNodeId(made));
        setEditing(made);
      }
    },
    [actions, selectOnly],
  );

  // ---- edge squares --------------------------------------------------------

  const squareMove = useCallback(
    (boxId: string, side: Side, drag: GripDrag) => {
      const from = sidePoint(rectOf(freeNodeId(boxId)), side);
      setGhostLine({ from, to: rf.screenToFlowPosition({ x: drag.event.clientX, y: drag.event.clientY }) });
    },
    [rectOf, rf],
  );

  const squareEnd = useCallback(
    (boxId: string, side: Side, drag: GripDrag, cancelled: boolean) => {
      setGhostLine(null);
      if (cancelled) return;
      const box = rectOf(freeNodeId(boxId));
      const screen = containerPoint({ x: drag.event.clientX, y: drag.event.clientY });
      if (!drag.moved) {
        const at = ghostSpot(box, side);
        const el = (drag.event.target as HTMLElement | null)?.getBoundingClientRect();
        void el;
        setPending({ screen: containerPoint(rf.flowToScreenPosition(sidePoint(box, side))), flow: at, fromBoxId: boxId });
        return;
      }
      const under = document.elementFromPoint(drag.event.clientX, drag.event.clientY)?.closest('.react-flow__node[data-id^="free:"]');
      const targetId = under?.getAttribute('data-id');
      if (targetId) {
        const other = parseFreeNodeId(targetId);
        if (other?.kind === 'box' && other.id !== boxId) actions.onConnectBoxes?.(boxId, other.id);
        return;
      }
      const flow = rf.screenToFlowPosition({ x: drag.event.clientX, y: drag.event.clientY });
      setPending({ screen, flow: { x: flow.x - BOX_W / 2, y: flow.y - BOX_H / 2 }, fromBoxId: boxId });
    },
    [rectOf, containerPoint, rf, actions],
  );

  // ---- the nodes and the lines ---------------------------------------------

  const squares = canDraw && selectedIds.length === 1 && selectedIds[0]!.startsWith('free:') && freeDrag === null;

  const nodes = useMemo<RFNode[]>(() => {
    const out: RFNode[] = [];
    // React Flow hides a node it has no size for, and this layer rebuilds its nodes on every change
    // without being told the sizes back, so each rebuild would hide every box for a frame (and drop
    // the focus of a note being typed into). Hand back the size React Flow already measured.
    const sizeKnown = (id: string): { measured?: { width: number; height: number } } => {
      const m = rf.getInternalNode(id)?.measured;
      return m?.width != null && m.height != null ? { measured: { width: m.width, height: m.height } } : {};
    };
    for (const l of labels) {
      const id = labelNodeId(l.id);
      const size = sizeOf(id);
      const data: LabelNodeData = {
        text: l.text,
        form: l.form,
        ...(l.author ? { author: l.author } : {}),
        w: size.w,
        h: size.h,
        editing: editing === l.id,
        grip: canDraw && l.form === 'area' && selSet.has(id) && selSet.size === 1,
        onEdit: (text) => {
          setEditing(null);
          if (text !== null && text !== l.text) actions.onSetLabel?.(l.id, { text });
        },
        onResize: (w, h, final) => {
          if (final) {
            setResizing(null);
            actions.onSetLabel?.(l.id, { w, h });
          } else setResizing({ id, w, h });
        },
      };
      out.push({
        id,
        type: 'label',
        position: posOf(id),
        data,
        selected: selSet.has(id),
        draggable: canDraw && editing !== l.id,
        zIndex: l.form === 'area' ? 0 : 3,
        ...sizeKnown(id),
      } satisfies RFNode);
    }
    for (const b of boxes) {
      const id = freeNodeId(b.id);
      const data: FreeBoxNodeData = {
        name: b.hostname || b.model || 'unnamed',
        role: b.role,
        model: b.model,
        squares: squares && selSet.has(id),
        onSquare: (side, drag, cancelled) => squareEnd(b.id, side, drag, cancelled),
        onSquareMove: (side, drag) => squareMove(b.id, side, drag),
      };
      out.push({ id, type: 'freeBox', position: posOf(id), data, selected: selSet.has(id), draggable: canDraw, zIndex: 2, ...sizeKnown(id) } satisfies RFNode);
    }
    return out;
  }, [labels, boxes, editing, canDraw, selSet, posOf, sizeOf, squares, squareEnd, squareMove, actions, rf]);

  const edges = useMemo<RFEdge[]>(
    () =>
      lines.map((l) => {
        const a = rectOf(freeNodeId(l.aId));
        const b = rectOf(freeNodeId(l.bId));
        const sides = lineSides(a, b);
        const data: LineEdgeData = {
          label: l.label,
          selected: selected?.kind === 'line' && selected.id === l.id,
          onSelect: () => {
            setGroup([]);
            onSelect({ kind: 'line', id: l.id });
          },
        };
        return {
          id: lineEdgeId(l.id),
          type: 'line',
          source: freeNodeId(l.aId),
          sourceHandle: sides.a,
          target: freeNodeId(l.bId),
          targetHandle: sides.b,
          selectable: false,
          zIndex: 1,
          data,
        } satisfies RFEdge;
      }),
    [lines, rectOf, selected, onSelect],
  );

  const fitIds = useMemo(() => [...boxes.map((b) => ({ id: freeNodeId(b.id) })), ...labels.map((l) => ({ id: labelNodeId(l.id) }))], [boxes, labels]);

  // ---- clicks and drags ----------------------------------------------------

  // Rack-mounted devices already picked: the Shift group, or the one device selected on its own.
  const rackedBase = useMemo(() => {
    if (racked.length > 0) return racked;
    return selected?.kind === 'chassis' && rackedLive.has(selected.id) ? [selected.id] : [];
  }, [racked, selected, rackedLive]);

  const onNodeClick = useCallback(
    (event: { shiftKey: boolean }, node: RFNode): boolean => {
      if (!parseFreeNodeId(node.id)) {
        // Shift+click on a rack-mounted device adds it to (or takes it out of) the picked devices.
        const parsedRacked = parseNodeId(node.id);
        if (!event.shiftKey || !canDraw || parsedRacked?.kind !== 'chassis' || !rackedLive.has(parsedRacked.id)) return false;
        const next = rackedBase.includes(parsedRacked.id) ? rackedBase.filter((i) => i !== parsedRacked.id) : [...rackedBase, parsedRacked.id];
        selectMany(selectedIds, next);
        return true;
      }
      if (event.shiftKey) {
        const next = selSet.has(node.id) ? selectedIds.filter((i) => i !== node.id) : [...selectedIds, node.id];
        selectMany(next, rackedBase);
      } else if (!(selSet.has(node.id) && selectedIds.length > 1)) {
        selectOnly(node.id);
      }
      return true;
    },
    [selSet, selectedIds, selectMany, selectOnly, canDraw, rackedLive, rackedBase],
  );

  const onNodeDoubleClick = useCallback(
    (node: RFNode): boolean => {
      const parsed = parseFreeNodeId(node.id);
      if (!parsed) return false;
      if (parsed.kind === 'label' && canDraw) setEditing(parsed.id);
      return true;
    },
    [canDraw],
  );

  const onNodeDragStart = useCallback(
    (node: RFNode, dragged: RFNode[]): boolean => {
      if (!parseFreeNodeId(node.id)) return false;
      if (!selSet.has(node.id)) selectOnly(node.id);
      const start: Record<string, Point> = {};
      const contents: Record<string, string[]> = {};
      for (const n of dragged.length > 0 ? dragged : [node]) {
        start[n.id] = basePos(n.id);
        const parsed = parseFreeNodeId(n.id);
        if (parsed?.kind === 'label' && labelById.get(parsed.id)?.form === 'area') {
          // An area carries what sits wholly inside it.
          const area = rectOf(n.id);
          const inside = allNodeIds.filter((o) => o !== n.id && !selSet.has(o) && contains(area, rectOf(o)) && labelById.get(idOf(o))?.form !== 'area');
          contents[n.id] = inside;
          for (const o of inside) start[o] = basePos(o);
        }
      }
      dragRef.current = { start, contents, last: start };
      return true;
    },
    [selSet, selectOnly, basePos, labelById, rectOf, allNodeIds],
  );

  const onNodeDrag = useCallback(
    (node: RFNode, dragged: RFNode[]): boolean => {
      const drag = dragRef.current;
      if (!parseFreeNodeId(node.id) || !drag) return false;
      const moving = dragged.length > 0 ? dragged : [node];
      const next: Record<string, Point> = {};
      for (const n of moving) {
        next[n.id] = { x: n.position.x, y: n.position.y };
        const from = drag.start[n.id];
        for (const inner of drag.contents[n.id] ?? []) {
          const s = drag.start[inner]!;
          next[inner] = { x: s.x + (n.position.x - (from?.x ?? n.position.x)), y: s.y + (n.position.y - (from?.y ?? n.position.y)) };
        }
      }
      // Guides: the moving group's own box against everything standing still.
      const movingIds = Object.keys(next);
      const movingRects = movingIds.map((id) => ({ ...next[id]!, ...sizeOf(id) }));
      const others = allNodeIds.filter((id) => !next[id] && labelById.get(idOf(id))?.form !== 'area').map(rectOf);
      const g = others.length > 0 ? guidesFor(boundsOf(movingRects), others, GUIDE_PX / rf.getZoom()) : null;
      if (g) {
        for (const id of movingIds) next[id] = { x: next[id]!.x + g.dx, y: next[id]!.y + g.dy };
      }
      drag.last = next;
      setFreeDrag(next);
      setGuides(g && (g.v.length > 0 || g.h.length > 0) ? g : null);
      return true;
    },
    [sizeOf, allNodeIds, labelById, rectOf, rf],
  );

  const onNodeDragStop = useCallback(
    (node: RFNode): boolean => {
      const drag = dragRef.current;
      if (!parseFreeNodeId(node.id) || !drag) return false;
      dragRef.current = null;
      setGuides(null);
      commitMoves(drag.last, drag.start);
      setFreeDrag(null);
      return true;
    },
    [commitMoves],
  );

  const onPaneClick = useCallback((): boolean => {
    setPending(null);
    setEditing(null);
    if (swallowPaneClick.current) {
      swallowPaneClick.current = false;
      return true;
    }
    setGroup([]);
    setRacked([]);
    return false;
  }, []);

  // ---- the marquee ---------------------------------------------------------

  const containerProps = useMemo(
    () => ({
      onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!canDraw || event.button !== 0 || spaceDown.current || event.pointerType === 'touch') return; // one finger pans on touch
        if (!(event.target as HTMLElement).classList.contains('react-flow__pane')) return;
        if (tool !== 'select' && !event.shiftKey) return; // a plain drag pans
        const startClient = { x: event.clientX, y: event.clientY };
        const additive = event.shiftKey;
        const base = additive ? selectedIds : [];
        let moved = false;
        const frame = (e: PointerEvent): Rect => rectFromPoints(containerPoint(startClient), containerPoint({ x: e.clientX, y: e.clientY }));
        const onMove = (e: PointerEvent) => {
          if (!moved && Math.hypot(e.clientX - startClient.x, e.clientY - startClient.y) < 4) return;
          moved = true;
          setMarquee(frame(e));
        };
        const onUp = (e: PointerEvent) => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          setMarquee(null);
          if (!moved) return;
          swallowPaneClick.current = true;
          setTimeout(() => (swallowPaneClick.current = false), 0);
          const a = rf.screenToFlowPosition(startClient);
          const b = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
          const box = rectFromPoints(a, b);
          const hit = allNodeIds.filter((id) => {
            const r = rectOf(id);
            return labelById.get(idOf(id))?.form === 'area' ? contains(box, r) : overlaps(box, r);
          });
          // Rack-mounted devices the box touches join too (each is a node of its own, measured live).
          const hitRacked = [...rackedLive].filter((id) => {
            const n = rf.getInternalNode(`chassis:${id}`);
            const p = n?.internals.positionAbsolute;
            return n != null && p != null && overlaps(box, { x: p.x, y: p.y, w: n.measured.width ?? 0, h: n.measured.height ?? 0 });
          });
          selectMany([...new Set([...base, ...hit])], [...new Set([...(additive ? rackedBase : []), ...hitRacked])]);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      },
    }),
    [canDraw, tool, selectedIds, containerPoint, rf, allNodeIds, rectOf, labelById, selectMany, rackedLive, rackedBase],
  );

  // ---- arranging -----------------------------------------------------------

  const arrange = useCallback(
    (positions: Point[]) => {
      actions.onMoveFree?.(selectedIds.map((id, i) => ({ id: idOf(id), x: positions[i]!.x, y: positions[i]!.y })));
    },
    [actions, selectedIds],
  );
  const selectedRects = useCallback(() => selectedIds.map(rectOf), [selectedIds, rectOf]);

  const group_ = useCallback(() => {
    const rect = groupRect(selectedRects());
    const made = actions.onAddLabel?.('area', 'Group', rect.x, rect.y, rect.w, rect.h);
    if (typeof made === 'string') {
      selectOnly(labelNodeId(made));
      setEditing(made);
    }
  }, [actions, selectedRects, selectOnly]);

  const label_ = useCallback(() => {
    const b = boundsOf(selectedRects());
    const made = actions.onAddLabel?.('text', 'Label', b.x, b.y - 32);
    if (typeof made === 'string') {
      selectOnly(labelNodeId(made));
      setEditing(made);
    }
  }, [actions, selectedRects, selectOnly]);

  // A note beside the selection, for teammates and for later (schema 0.20).
  const note_ = useCallback(() => {
    const b = boundsOf(selectedRects());
    const made = actions.onAddLabel?.('note', 'Note', b.x + b.w + 16, b.y);
    if (typeof made === 'string') {
      selectOnly(labelNodeId(made));
      setEditing(made);
    }
  }, [actions, selectedRects, selectOnly]);

  // ---- keys ----------------------------------------------------------------

  const removeSelected = useCallback((): boolean => {
    if (selected?.kind === 'line') {
      actions.onRemoveFree?.([selected.id]);
      return true;
    }
    if (selectedIds.length === 0) return false;
    actions.onRemoveFree?.(selectedIds.map(idOf));
    setGroup([]);
    onSelect(null);
    return true;
  }, [selected, selectedIds, actions, onSelect]);

  const duplicate = useCallback(
    (ids: string[], step: number) => {
      const made = actions.onDuplicateFree?.(ids.map(idOf), PASTE_STEP * step, PASTE_STEP * step);
      if (Array.isArray(made) && made.length > 0) {
        selectMany(made.map((id) => (id.startsWith('chassis:') ? freeNodeId(id) : labelNodeId(id))));
      }
    },
    [actions, selectMany],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      if (event.key === ' ') spaceDown.current = true;
      const el = document.activeElement;
      const inField = el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
      if (inField || !canDraw) return false;
      const mod = event.ctrlKey || event.metaKey;
      if (event.key === 'Escape' && (pending || group.length > 0 || racked.length > 0 || editing)) {
        setPending(null);
        setEditing(null);
        setGroup([]);
        setRacked([]);
        return true;
      }
      if (mod && (event.key === 'a' || event.key === 'A') && allNodeIds.length > 0) {
        event.preventDefault();
        selectMany(allNodeIds);
        return true;
      }
      if (mod && (event.key === 'c' || event.key === 'C') && selectedIds.length > 0) {
        clipboard.current = [...selectedIds];
        pasteCount.current = 0;
        return true;
      }
      if (mod && (event.key === 'v' || event.key === 'V') && clipboard.current.length > 0) {
        event.preventDefault();
        pasteCount.current += 1;
        duplicate(clipboard.current.filter((id) => allNodeIds.includes(id)), pasteCount.current);
        return true;
      }
      if (mod && (event.key === 'd' || event.key === 'D') && selectedIds.length > 0) {
        event.preventDefault();
        duplicate(selectedIds, 1);
        return true;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && (group.length > 0 || selected?.kind === 'label' || selected?.kind === 'line')) {
        event.preventDefault();
        return removeSelected();
      }
      const step = event.shiftKey ? NUDGE_BIG : NUDGE;
      const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (dir && selectedIds.length > 0 && !mod) {
        event.preventDefault();
        const total = { x: (nudgeRef.current?.x ?? 0) + dir[0]! * step, y: (nudgeRef.current?.y ?? 0) + dir[1]! * step };
        nudgeRef.current = total;
        setNudged(total);
        if (nudgeTimer.current) clearTimeout(nudgeTimer.current);
        nudgeTimer.current = setTimeout(flushNudge, NUDGE_FLUSH_MS);
        return true;
      }
      return false;
    },
    [canDraw, pending, group, racked, editing, allNodeIds, selectedIds, selected, selectMany, duplicate, removeSelected, flushNudge],
  );

  useEffect(() => {
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') spaceDown.current = false;
    };
    window.addEventListener('keyup', up);
    return () => window.removeEventListener('keyup', up);
  }, []);

  // ---- several devices at once ---------------------------------------------

  // The chassis ids of every device in a multi-selection (free boxes and rack-mounted ones); only
  // while it is a group (nothing single is selected).
  const deviceIds = useMemo(() => {
    if (selected !== null) return [];
    const freeBoxes = selectedIds.flatMap((id) => (parseFreeNodeId(id)?.kind === 'box' ? [idOf(id)] : []));
    const all = [...freeBoxes, ...racked];
    return all.length >= 2 ? all : [];
  }, [selected, selectedIds, racked]);

  const clearGroup = useCallback(() => {
    setGroup([]);
    setRacked([]);
    onSelect(null);
  }, [onSelect]);

  // The picked rack-mounted devices wear an outline (a class on the box's static wrapper, which React never rewrites).
  useEffect(() => {
    const root = containerRef.current;
    if (!root || racked.length === 0) return undefined;
    const els = racked.flatMap((id) => {
      const el = root.querySelector(`[data-id="${CSS.escape(`chassis:${id}`)}"] .drawing-chassis-wrap`);
      return el ? [el] : [];
    });
    els.forEach((el) => el.classList.add('drawing-chassis-wrap--picked'));
    return () => els.forEach((el) => el.classList.remove('drawing-chassis-wrap--picked'));
  }, [racked, containerRef, view]);

  // ---- what is drawn over the canvas ---------------------------------------

  const showWordMenu = canDraw && selectedIds.length > 0 && freeDrag === null && editing === null && !(selectedIds.length === 1 && selectedIds[0]!.startsWith('label:'));
  const bounds = showWordMenu ? boundsOf(selectedRects()) : null;

  const portal = (
    <ViewportPortal>
      <FreeGuides guides={guides} ghostLine={ghostLine} pending={pending && !pending.rack ? { ...pending.flow, w: BOX_W, h: BOX_H } : null} pendingFrom={pending?.fromBoxId ? rectOf(freeNodeId(pending.fromBoxId)) : null} />
    </ViewportPortal>
  );

  const overlay = (
    <>
      {bounds ? (
        <Anchored rf={rf} containerRef={containerRef} at={{ x: bounds.x + bounds.w / 2, y: bounds.y }}>
          {(screen) => (
            <WordMenu
              x={screen.x}
              y={screen.y}
              count={selectedIds.length}
              onAlign={(mode: AlignMode) => arrange(alignRects(selectedRects(), mode))}
              onSpread={(axis) => arrange(spreadRects(selectedRects(), axis))}
              onGroup={group_}
              onLabel={label_}
              onNote={actions.onAddLabel ? note_ : undefined}
            />
          )}
        </Anchored>
      ) : null}
      {marquee ? <div className="free-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} /> : null}
      {pending ? (
        <ContextMenu
          key={`${pending.screen.x},${pending.screen.y}`}
          x={pending.screen.x + (pending.rack ? 12 : (BOX_W / 2) * rf.getZoom() + 8)}
          y={pending.screen.y}
          onClose={() => setPending(null)}
          items={[
            ...[...BOX_KINDS]
              .sort((a, b) => (a.role === lastKind ? -1 : b.role === lastKind ? 1 : 0))
              .map((k) => ({ label: k.label, onSelect: () => addBox(k.role) })),
            // A box can start from a saved faceplate (not offered for a rack unit: those take the catalogue's).
            ...(!pending.rack && actions.onAddFreeBoxFromTemplate ? templates.map((t) => ({ label: `From template: ${t.name}`, onSelect: () => addFromTemplate(t.id) })) : []),
          ]}
        />
      ) : null}
    </>
  );

  return {
    nodes,
    edges,
    fitIds,
    portal,
    overlay,
    onNodeClick,
    onNodeDoubleClick,
    onNodeDragStart,
    onNodeDrag,
    onNodeDragStop,
    onPaneClick,
    onKeyDown,
    dropBox,
    openAdd,
    addLabelAt,
    containerProps,
    panModifier: false,
    hasSelection: selectedIds.length > 0 || racked.length > 0,
    selectedIds,
    removeSelected,
    deviceIds,
    clearGroup,
  };
}

/** Re-renders its child at the selection's screen position whenever the camera moves. */
function Anchored({
  rf,
  containerRef,
  at,
  children,
}: {
  rf: RF;
  containerRef: RefObject<HTMLDivElement | null>;
  at: Point;
  children: (screen: Point) => ReactNode;
}) {
  useViewport();
  const frame = containerRef.current?.getBoundingClientRect();
  const s = rf.flowToScreenPosition(at);
  return <>{children({ x: s.x - (frame?.left ?? 0), y: s.y - (frame?.top ?? 0) })}</>;
}

/** Dotted guides, the line being drawn and the ghost of a box about to be added, in flow space. */
function FreeGuides({ guides, ghostLine, pending, pendingFrom }: { guides: Guides | null; ghostLine: { from: Point; to: Point } | null; pending: Rect | null; pendingFrom: Rect | null }) {
  if (!guides && !ghostLine && !pending) return null;
  return (
    <svg className="free-overlay" width="1" height="1" style={{ overflow: 'visible', position: 'absolute', pointerEvents: 'none' }}>
      {guides?.v.map((l, i) => <line key={`v${i}`} x1={l.x} x2={l.x} y1={l.y1 - 8} y2={l.y2 + 8} className="free-guide" />)}
      {guides?.h.map((l, i) => <line key={`h${i}`} y1={l.y} y2={l.y} x1={l.x1 - 8} x2={l.x2 + 8} className="free-guide" />)}
      {ghostLine ? <line x1={ghostLine.from.x} y1={ghostLine.from.y} x2={ghostLine.to.x} y2={ghostLine.to.y} className="free-line__proposed" /> : null}
      {pending && pendingFrom
        ? (() => {
            const s = lineSides(pendingFrom, pending);
            const a = sidePoint(pendingFrom, s.a);
            const b = sidePoint(pending, s.b);
            return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="free-line__proposed" />;
          })()
        : null}
      {pending ? <rect x={pending.x} y={pending.y} width={pending.w} height={pending.h} className="free-ghost" /> : null}
      {pending ? (
        <text x={pending.x + 8} y={pending.y + pending.h / 2} dominantBaseline="central" className="free-ghost__label">
          NEW · pick a kind
        </text>
      ) : null}
    </svg>
  );
}

export { AREA_MIN_H, AREA_MIN_W, centreOf };
