// Sign-off shelf-view (answer C, both): stepping into a shelf draws it twice, lined up: a strip seen
// from above, over the shelf seen from one side between the rack's posts, both to scale (the strip
// at half depth). Each thing sits where it really is: along the shelf (SitsOn.x_mm) and back from
// the lip (SitsOn.y_mm). Drag it in either drawing; it stops against its neighbours and its cables
// follow and settle. Dashed lines join each thing's two drawings, and pointing at either lights both,
// so the two read as one shelf (the owner's note, "make it more obvious").
// Front, Right, Back and Left walk round the shelf, because ports are sometimes on a side (the owner's
// note on version 2). Click a free port, then the port at the other end on any side, to run a cable.
// A cable between two ports in view hangs between them; one that leaves the view runs down the nearer
// post with a tag naming its far end. A click selects (the panel beside shows it), a double-click on a
// device opens it, and the bar's path and Esc lead back out, as before (sign-off r63).
import { useEffect, useMemo, useRef, useState, type JSX, type RefObject, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from 'react';

import type { ClosetView, OccupantView, PortView } from '../../document/view';
import type { Selection } from '../drawing/contract';
import { hangCable, type Obstacle, type Pt } from '../drawing/cablePhysics';
import { useCableSway } from '../drawing/cableShape';
import { findShelf } from '../drawing/lookup';
import { SHEATH_VAR } from '../drawing/sheath';
import { deviceChassis } from '../jot/jotLayout';
import {
  SHELF_DEPTH_MM,
  SHELF_FACES,
  SHELF_INSIDE_MM,
  depthSlide,
  dropOnPlan,
  dropSpot,
  faceSpan,
  fromFace,
  hiddenBehind,
  layoutShelf,
  onFace,
  portsOnFace,
  rowOf,
  type ShelfFace,
  type ShelfItem,
} from './shelfLayout';
import './shelfRoom.css';

export interface ShelfRoomProps {
  view: ClosetView;
  shelfId: string;
  selected: Selection | null;
  /** A card or an opened device is over this view: it takes the keys. */
  paused: boolean;
  onSelect: (selection: Selection | null) => void;
  /** Opens a device on the shelf, the same as Open on it anywhere else. */
  onOpenDevice: (chassisId: string) => void;
  onBack: () => void;
  /** Present for a writer: sets where things sit along the shelf. A refusal is shown under the shelf. */
  onArrange?: (shelfId: string, positions: Array<{ itemId: string; xMm: number; yMm?: number }>) => { refused: string } | void;
  /** Present for a writer: runs a cable between two ports, the same as dragging port to port on the canvas. */
  onConnect?: (fromPortId: string, toPortId: string) => void;
  /** The design with an AI idea's change made on a copy, while the ideas panel shows it: the shelf is drawn
   * as the idea would leave it, what it moves or adds in the plan colour, and nothing can be dragged. */
  proposed?: ClosetView;
}

function focusInField(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLElement && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName));
}

/** Pixels a millimetre, from the stage's width; 2 before it is measured (and when rendered to a string). */
function useScale(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [k, setK] = useState(2);
  useEffect(() => {
    const el = ref.current;
    if (el == null || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width ?? 0;
      // The room's height below the bar, not the stage's own, which grows with what it draws.
      const room = el.parentElement;
      const h = room != null ? room.clientHeight - el.offsetTop : 0;
      if (w <= 0) return;
      const byWidth = (w - 2 * MARGIN_PX) / SHELF_INSIDE_MM;
      // Both drawings and the cables under the shelf should fit the stage's height when they can.
      const byHeight = h > 0 ? (h - FIXED_HEIGHT_PX) / (SHELF_DEPTH_MM * DEPTH_SCALE + TYPICAL_TALL_MM) : byWidth;
      setK(Math.min(2.4, Math.max(1.2, Math.min(byWidth, byHeight))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, k];
}

const MARGIN_PX = 70;
/** The strip seen from above is drawn at this share of the side view's scale away from the viewer, so
 * both fit on one screen; its label says so. Across the view the two share one scale and line up. */
const DEPTH_SCALE = 0.5;
const PLAN_TOP_PX = 44;
/** The drawing's height that does not grow with the scale (labels, the cables' drop, the hint), and the
 * height of a typical thing on a shelf, for fitting the drawing to the stage. */
const FIXED_HEIGHT_PX = 470;
const TYPICAL_TALL_MM = 50;
/** The room between the strip and the side view, for the side view's label and the measure. */
const BETWEEN_PX = 64;
const POST_PX = 18;
const PORT_GAP_PX = 2;
/** How far below (or above) the shelf a cable leaving it is drawn to, on the post. */
const DROP_PX = 150;
/** A port's pitch on a desktop switch, and the size an RJ45 opening is drawn at, in millimetres. */
const PORT_PITCH_MM = 14;
const PORT_W_MM = 11;
/** The space between two cables running down the same post. */
const POST_LANE_PX = 10;

/** What each side is called on its button, in the drawing's captions, and when naming where ports are. */
const FACE_BUTTON: Record<ShelfFace, string> = { front: 'Front', right: 'Right', rear: 'Back', left: 'Left' };
const FACE_CAPTION: Record<ShelfFace, string> = { front: 'FRONT', right: 'RIGHT END', rear: 'BACK', left: 'LEFT END' };
const FACE_WORD: Record<ShelfFace, string> = { front: 'front', right: 'right side', rear: 'back', left: 'left side' };
const FACE_SHORT: Record<ShelfFace, string> = { front: 'front', right: 'right', rear: 'back', left: 'left' };

function listed(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

interface PortSpot {
  port: PortView;
  occupantId: string;
  x: number;
  y: number;
  size: number;
}

export function ShelfRoom({ view: realView, shelfId, selected, paused, onSelect, onOpenDevice, onBack, onArrange: arrangeProp, onConnect: connectProp, proposed }: ShelfRoomProps): JSX.Element {
  const realFound = findShelf(realView, shelfId);
  const proposedFound = proposed != null ? findShelf(proposed, shelfId) : null;
  // While an AI idea is shown the shelf is drawn as it would leave it, and only Accept in the ideas panel changes it.
  const showingIdea = proposedFound != null;
  const found = proposedFound ?? realFound;
  const view = showingIdea ? proposed! : realView;
  const onArrange = showingIdea ? undefined : arrangeProp;
  const onConnect = showingIdea ? undefined : connectProp;
  const [stageRef, k] = useScale();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [face, setFace] = useState<ShelfFace>('front');
  const [snap, setSnap] = useState(true);
  const [drag, setDrag] = useState<{
    id: string;
    /** Which drawing it was picked up in: the side view slides it across the view, the strip either way. */
    from: 'front' | 'plan';
    x: number;
    y: number;
    startClientX: number;
    startClientY: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  /** The port a cable is being run from, waiting for a click on its other end (on any side). */
  const [pending, setPending] = useState<string | null>(null);
  const [pointer, setPointer] = useState<Pt | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (paused || focusInField() || e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      // Esc first lets go of a cable being run, and only then leaves the shelf.
      if (pending != null) {
        setPending(null);
        return;
      }
      onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paused, onBack, pending]);

  const occupants = useMemo(() => found?.shelf.occupants ?? [], [found]);
  const items = useMemo(() => layoutShelf(occupants), [occupants]);

  if (found == null) return <div className="shelf-room shelf-room--gone">That shelf is no longer in the design.</div>;
  const { rack, shelf } = found;

  // The box each thing is drawn in now, the one being dragged where it is being dragged to.
  const shown: ShelfItem[] = items.map((it) => (drag != null && drag.id === it.id ? { ...it, xMm: drag.x, yMm: drag.y } : it));
  const byId = new Map(occupants.map((o) => [o.id, o]));
  const unplaced = items.filter((it) => !it.placed).length;
  const farName = (chassisId: string | null) => (chassisId == null ? null : deviceChassis(view, chassisId)?.hostname || null);
  const sheathOf = (cableId: string) => view.cables.find((c) => c.id === cableId)?.sheath ?? null;
  const portFace = new Map(occupants.flatMap((o) => o.ports.map((p) => [p.id, p.face] as const)));
  const pendingPort = pending != null ? occupants.flatMap((o) => o.ports).find((p) => p.id === pending) : undefined;
  const pendingOwner = pending != null ? occupants.find((o) => o.ports.some((p) => p.id === pending)) : undefined;
  // What the idea shown moves, adds or cables, against the design as it is.
  const realOccupants = new Map((realFound?.shelf.occupants ?? []).map((o) => [o.id, o]));
  const realCables = new Set(realView.cables.map((c) => c.id));
  const aiWord = (o: OccupantView): string | null => {
    if (!showingIdea) return null;
    const was = realOccupants.get(o.id);
    if (was == null) return 'AI ADDS';
    return (was.xMm ?? null) !== (o.xMm ?? null) || (was.yMm ?? 0) !== (o.yMm ?? 0) ? 'AI MOVES' : null;
  };
  const aiCable = (cableId: string) => showingIdea && !realCables.has(cableId);
  const aiCount = showingIdea ? occupants.filter((o) => aiWord(o) != null).length : 0;
  const aiCables = showingIdea ? new Set(occupants.flatMap((o) => o.ports.map((p) => p.cable?.cableId)).filter((c): c is string => c != null && aiCable(c))).size : 0;

  // Geometry, in pixels. Each side is drawn as you would see it standing there: `u` across, `v` away.
  const span = faceSpan(face);
  const at = (it: ShelfItem) => onFace(it, face);
  const sideways = face === 'left' || face === 'right';
  const alongMax = Math.max(span.alongMm, ...shown.map((it) => at(it).u + at(it).uw));
  const awayMax = Math.max(span.awayMm, ...shown.map((it) => at(it).v + at(it).vd));
  const nearest = Math.min(0, ...shown.map((it) => at(it).v));
  const tallest = Math.max(40, ...shown.map((it) => it.hMm));
  const x0 = MARGIN_PX;
  const W = span.alongMm * k;
  // From an end the strip runs the shelf's 450 mm away from you: drawn at a third so it stays the height it is from the front.
  const kd = k * DEPTH_SCALE * (SHELF_DEPTH_MM / span.awayMm);
  const planTop = PLAN_TOP_PX + (awayMax - span.awayMm) * kd;
  const planH = span.awayMm * kd;
  /** The strip's edge on the viewer's side, nearest the side view. */
  const planBottom = planTop + planH;
  const vy = (v: number) => planBottom - v * kd;
  const frontTop = planBottom - nearest * kd + BETWEEN_PX;
  const shelfY = frontTop + DROP_PX * 0.6 + tallest * k;
  const svgW = x0 + alongMax * k + MARGIN_PX;
  const svgH = shelfY + DROP_PX + 70;
  const boxX = (it: ShelfItem) => x0 + at(it).u * k;
  const planBoxY = (it: ShelfItem) => vy(at(it).v + at(it).vd);
  // The shelf's front lip in the strip: along its near edge from the front, its far edge from behind,
  // and down one end from either side.
  const lip =
    face === 'front'
      ? { x: x0, y: planBottom - 1.5, w: W, h: 3 }
      : face === 'rear'
        ? { x: x0, y: planTop - 1.5, w: W, h: 3 }
        : { x: face === 'right' ? x0 - 1.5 : x0 + W - 1.5, y: planTop, w: 3, h: planH };

  const portSpots: PortSpot[] = [];
  for (const it of shown) {
    const o = byId.get(it.id);
    if (o == null) continue;
    const ports = portsOnFace(o, face);
    if (ports.length === 0) continue;
    const rows = ports.length > 24 ? 2 : 1;
    const perRow = Math.ceil(ports.length / rows);
    const w = at(it).uw * k;
    const pitch = Math.min(PORT_PITCH_MM * k, (w - 12) / perRow);
    const size = Math.max(4, Math.min(PORT_W_MM * k, pitch - PORT_GAP_PX));
    const right = boxX(it) + w - 6;
    ports.forEach((port, i) => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const x = right - (perRow - col) * pitch + pitch / 2;
      const y = shelfY - 6 - (rows - row) * (size * 0.8 + PORT_GAP_PX) + size * 0.4;
      portSpots.push({ port, occupantId: it.id, x, y, size });
    });
  }
  const spotByPort = new Map(portSpots.map((s) => [s.port.id, s]));

  interface Hang {
    id: string;
    a: Pt;
    b: Pt;
    slack: number;
    stroke: string;
    tag: string | null;
    up: boolean;
    /** What the cable rests on as it runs: the boxes it climbs over on its way up the post. */
    obstacles: Obstacle[];
    /** A cable the AI idea shown would add. */
    ai: boolean;
  }
  const hangs: Hang[] = [];
  const seen = new Set<string>();
  const leaving: Array<{ left: boolean; up: boolean }> = [];
  for (const s of portSpots) {
    const cable = s.port.cable;
    if (cable == null || seen.has(cable.cableId)) continue;
    seen.add(cable.cableId);
    const sheath = sheathOf(cable.cableId);
    const stroke = sheath != null ? SHEATH_VAR[sheath] : 'var(--muted)';
    const far = cable.farPortId != null ? spotByPort.get(cable.farPortId) : undefined;
    const a = { x: s.x, y: s.y + 3 };
    if (far != null) {
      const b = { x: far.x, y: far.y + 3 };
      hangs.push({ id: cable.cableId, a, b, slack: 0.3, stroke, tag: null, up: false, obstacles: [], ai: aiCable(cable.cableId) });
      continue;
    }
    const onShelfElsewhere = cable.farChassisId != null && byId.has(cable.farChassisId);
    const left = s.x < x0 + W / 2;
    // A cable to a device racked above the shelf climbs the post; every other one drops down it.
    const farRacked = cable.farChassisId != null ? rack.chassis.find((c) => c.id === cable.farChassisId) : undefined;
    const up = farRacked != null && farRacked.positionU > shelf.positionU;
    const lane = leaving.filter((l) => l.left === left && l.up === up).length;
    const postX = left ? x0 - POST_PX / 2 - 8 : x0 + W + 8 + POST_PX / 2;
    const b = { x: postX + (left ? 1 : -1) * (lane % 2 === 0 ? 0 : 4), y: up ? frontTop + 40 + lane * POST_LANE_PX : shelfY + DROP_PX + lane * POST_LANE_PX };
    const name = farName(cable.farChassisId);
    const farFace = cable.farPortId != null ? portFace.get(cable.farPortId) : undefined;
    const tag = onShelfElsewhere
      ? `to ${name ?? 'this shelf'}${farFace != null && farFace !== 'top' ? `, its ${FACE_WORD[farFace]}` : ''}`
      : `to ${name ?? (cable.outsideCloset ? 'another closet' : '—')}${up ? ', above' : ''}`;
    leaving.push({ left, up });
    hangs.push({ id: cable.cableId, a, b, slack: up ? 0.04 : 0.12, stroke, tag, up, obstacles: [], ai: aiCable(cable.cableId) });
  }

  const select = (sel: Selection) => onSelect(sel);
  const others = (id: string) => items.filter((it) => it.id !== id);

  const commit = (id: string, x: number, y: number) => {
    if (onArrange == null) return;
    // Everything laid out by slot is pinned where it is drawn, so placing one thing never moves another.
    const positions = [{ itemId: id, xMm: x, yMm: y }, ...items.filter((it) => it.id !== id && !it.placed && !it.over).map((it) => ({ itemId: it.id, xMm: it.xMm }))];
    const result = onArrange(shelf.id, positions);
    setRefusal(result != null && 'refused' in result ? result.refused : null);
  };

  /** Where a thing lands slid `du` across the side view: along the shelf from the front or back, front to back from an end. */
  const slideAcross = (it: ShelfItem, startX: number, startY: number, du: number, doSnap: boolean): { x: number; y: number } | null => {
    const { dx, dy } = fromFace(face, du, 0);
    if (!sideways) {
      const x = dropSpot(rowOf(others(it.id), { yMm: startY, dMm: it.dMm }), it.wMm, startX + dx, doSnap);
      return x == null ? null : { x, y: startY };
    }
    const y = depthSlide(others(it.id), { ...it, xMm: startX }, startY + dy, doSnap);
    return y == null ? null : { x: startX, y };
  };
  /** Where a thing lands moved in the strip: `du` across, `dv` away from the viewer. */
  const moveInPlan = (it: ShelfItem, startX: number, startY: number, du: number, dv: number, doSnap: boolean): { x: number; y: number } | null => {
    const { dx, dy } = fromFace(face, du, dv);
    const spot = dropOnPlan(others(it.id), it, startX + dx, startY + dy, doSnap);
    return spot == null ? null : { x: spot.xMm, y: spot.yMm };
  };

  const onDown = (e: ReactPointerEvent, it: ShelfItem, from: 'front' | 'plan') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (onArrange == null) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDrag({ id: it.id, from, x: it.xMm, y: it.yMm, startClientX: e.clientX, startClientY: e.clientY, startX: it.xMm, startY: it.yMm, moved: false });
  };
  const onMove = (e: ReactPointerEvent, it: ShelfItem) => {
    if (drag == null || drag.id !== it.id) return;
    const dxPx = e.clientX - drag.startClientX;
    const dyPx = e.clientY - drag.startClientY;
    const moved = drag.moved || Math.hypot(dxPx, dyPx) > 3;
    const doSnap = snap && !e.altKey;
    // In the strip, up the screen is further from the viewer.
    const spot = drag.from === 'front' ? slideAcross(it, drag.startX, drag.startY, dxPx / k, doSnap) : moveInPlan(it, drag.startX, drag.startY, dxPx / k, -dyPx / kd, doSnap);
    setDrag({ ...drag, ...(spot != null ? { x: spot.x, y: spot.y } : {}), moved });
  };
  const onUp = (it: ShelfItem) => {
    if (drag == null || drag.id !== it.id) return;
    setDrag(null);
    // Against where it is saved: the item drawn mid-drag already carries the drag's position.
    const saved = items.find((s) => s.id === it.id) ?? it;
    if (drag.moved && (drag.x !== saved.xMm || drag.y !== saved.yMm || !saved.placed)) commit(it.id, drag.x, drag.y);
  };
  const onKey = (e: ReactKeyboardEvent, it: ShelfItem, o: OccupantView) => {
    const isDevice = o.kind === 'chassis';
    const step = e.shiftKey ? 1 : 10;
    let spot: { x: number; y: number } | null = null;
    if (e.key === 'Enter' && isDevice) onOpenDevice(o.id);
    else if (e.key === ' ') select({ kind: 'occupant', id: o.id });
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && onArrange != null) spot = slideAcross(it, it.xMm, it.yMm, step * (e.key === 'ArrowRight' ? 1 : -1), false);
    // Up in the strip: further from the viewer.
    else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && onArrange != null) spot = moveInPlan(it, it.xMm, it.yMm, 0, step * (e.key === 'ArrowUp' ? 1 : -1), false);
    else return;
    if (spot != null && (spot.x !== it.xMm || spot.y !== it.yMm)) commit(it.id, spot.x, spot.y);
    e.preventDefault();
    e.stopPropagation();
  };

  const onPortClick = (e: ReactMouseEvent, port: PortView) => {
    e.stopPropagation();
    select({ kind: 'port', id: port.id });
    if (onConnect == null) return;
    if (pending == null) {
      if (port.cable == null) {
        setPending(port.id);
        setRefusal(null);
      }
    } else if (pending === port.id) setPending(null);
    else if (port.cable != null) setRefusal('That port already has a cable. A port takes one: pick a free one, or Esc to stop.');
    else {
      onConnect(pending, port.id);
      setPending(null);
      setRefusal(null);
    }
  };
  const onSvgMove = (e: ReactPointerEvent) => {
    if (pending == null || svgRef.current == null) return;
    const r = svgRef.current.getBoundingClientRect();
    setPointer({ x: e.clientX - r.left, y: e.clientY - r.top });
  };

  const draggingItem = drag != null && drag.moved ? shown.find((it) => it.id === drag.id) : undefined;
  const pendingSpot = pending != null ? spotByPort.get(pending) : undefined;
  // While dragging: across the side view from the front or back, the distance from the view's left
  // edge; from an end, how far back from the lip.
  const measure = (() => {
    if (draggingItem == null) return null;
    if (!sideways) {
      if (drag?.from !== 'front') return null;
      const edge = boxX(draggingItem);
      return { a: x0, b: edge, label: `${Math.round(at(draggingItem).u)} mm` };
    }
    const lipX = face === 'right' ? x0 : x0 + W;
    const frontFace = face === 'right' ? boxX(draggingItem) : boxX(draggingItem) + at(draggingItem).uw * k;
    return { a: lipX, b: frontFace, label: `${Math.round(draggingItem.yMm)} mm back` };
  })();

  return (
    <div className="shelf-room" data-testid="shelf-room" onClick={() => onSelect({ kind: 'shelf', id: shelf.id })}>
      <div className="shelf-room__bar">
        {/* As with an opened device, no "← Rack" here: the bar's path and Esc lead back out. */}
        <span className="shelf-room__name">{shelf.label || 'Shelf'}</span>
        <span className="shelf-room__meta">
          SHELF {shelf.heightU}U · {rack.label || 'Rack'} U{shelf.positionU} · {shelf.occupants.length} on it
          {unplaced > 0 && onArrange != null ? ` · ${unplaced} not placed by hand yet` : ''}
        </span>
        <span className="shelf-room__grow" />
        <span className="shelf-room__tools" role="group" aria-label="Which side" onClick={(e) => e.stopPropagation()}>
          {SHELF_FACES.map((f) => (
            <button key={f} type="button" className="shelf-room__tool" aria-pressed={face === f} onClick={() => setFace(f)} title={`Look at the shelf from the ${f === 'front' || f === 'rear' ? FACE_SHORT[f] : `${f} end`}`}>
              {FACE_BUTTON[f]}
            </button>
          ))}
          {onArrange != null ? (
            <button type="button" className="shelf-room__tool" aria-pressed={snap} onClick={() => setSnap((s) => !s)} title="Snap to neighbours and 10 mm steps. Hold Alt while dragging to place freely.">
              Snap: {snap ? 'on' : 'off'}
            </button>
          ) : null}
        </span>
      </div>
      <div className="shelf-room__stage" ref={stageRef}>
        {occupants.length === 0 ? <div className="shelf-room__empty">Nothing on this shelf yet.</div> : null}
        {showingIdea ? (
          <p className="shelf-room__idea" role="status" onClick={(e) => e.stopPropagation()}>
            Showing an AI idea on this shelf
            {aiCount > 0 ? `: it moves or adds ${aiCount} thing${aiCount === 1 ? '' : 's'}` : ''}
            {aiCables > 0 ? `${aiCount > 0 ? ' and' : ':'} runs ${aiCables} cable${aiCables === 1 ? '' : 's'}` : ''}. Accept or dismiss it in the ideas panel; nothing here can be dragged until then.
          </p>
        ) : null}
        {pendingPort != null ? (
          <p className="shelf-room__pending" role="status" onClick={(e) => e.stopPropagation()}>
            Running a cable from <b>{pendingOwner?.label || 'unnamed'} {pendingPort.label}</b>
            {pendingSpot == null ? ` (on its ${FACE_WORD[pendingPort.face === 'top' ? 'front' : pendingPort.face]})` : ''}. Click the port at the other end, on any side: Front, Right, Back and Left turn the shelf.{' '}
            <button type="button" className="shelf-room__tool" onClick={() => setPending(null)}>
              Stop
            </button>
          </p>
        ) : null}
        <svg
          ref={svgRef}
          className="shelf-room__svg"
          width={svgW}
          height={svgH}
          viewBox={`0 0 ${svgW} ${svgH}`}
          role="img"
          aria-label={`${shelf.label || 'Shelf'} from the ${face === 'front' || face === 'rear' ? FACE_SHORT[face] : `${face} end`}`}
          onPointerMove={onSvgMove}
        >
          <defs>
            <pattern id="shelf-room-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" className="shelf-room__hatch-line" />
            </pattern>
          </defs>
          {/* The strip seen from above: the shelf's tray, turned so the side you are looking from is nearest the drawing under it. */}
          <g className="shelf-room__plan" aria-hidden="true">
            <text className="shelf-room__mono shelf-room__view-label" x={x0} y={planTop - 12}>
              FROM ABOVE{onArrange != null ? (sideways ? ' · drag to move it' : ' · drag to set how far back') : ''} · {sideways ? 'its length drawn at a third' : 'drawn at half depth'}
            </text>
            <rect className="shelf-room__plan-tray" x={x0} y={planTop} width={W} height={planH} />
            <rect className="shelf-room__plan-lip" x={lip.x} y={lip.y} width={lip.w} height={lip.h} />
            {sideways ? (
              <>
                <text className="shelf-room__mono" x={face === 'right' ? x0 - 8 : x0 + W + 8} y={planTop + planH / 2 + 4} textAnchor={face === 'right' ? 'end' : 'start'}>
                  FRONT
                </text>
                <text className="shelf-room__mono" x={face === 'right' ? x0 + W + 8 : x0 - 8} y={planTop + planH / 2 + 4} textAnchor={face === 'right' ? 'start' : 'end'}>
                  BACK
                </text>
              </>
            ) : (
              <>
                <text className="shelf-room__mono" x={x0 - 8} y={(face === 'front' ? planBottom : planTop) + 4} textAnchor="end">
                  FRONT
                </text>
                <text className="shelf-room__mono" x={x0 - 8} y={(face === 'front' ? planTop : planBottom) + 4} textAnchor="end">
                  BACK
                </text>
              </>
            )}
          </g>
          <text className="shelf-room__mono shelf-room__view-label" x={x0} y={frontTop - 10} aria-hidden="true">
            FROM THE {FACE_CAPTION[face]}
            {onArrange != null ? (sideways ? ' · drag front or back' : ' · drag left or right') : ''}
          </text>
          {/* The rack's posts (from an end, its front and back posts), and the shelf's tray with its edge. */}
          <rect className="shelf-room__post" x={x0 - POST_PX - 8} y={frontTop - 4} width={POST_PX} height={svgH - frontTop - 4} />
          <rect className="shelf-room__post" x={x0 + W + 8} y={frontTop - 4} width={POST_PX} height={svgH - frontTop - 4} />
          <rect className="shelf-room__tray" x={x0 - 8} y={shelfY} width={W + 16} height={10} />
          <rect className="shelf-room__lip" x={x0 - 8} y={shelfY + 10} width={W + 16} height={3} />
          <text className="shelf-room__mono" x={x0 + W} y={shelfY + 28} textAnchor="end">
            {FACE_CAPTION[face]} · {sideways ? `${SHELF_DEPTH_MM} MM DEEP` : `${SHELF_INSIDE_MM} MM INSIDE`}
          </text>
          {/* The lines that join each thing's two drawings: faint always, dark for the one pointed at or selected. */}
          {shown.map((it) => {
            const lit = hover === it.id || (selected?.kind === 'occupant' && selected.id === it.id);
            const x = boxX(it);
            const w = at(it).uw * k;
            const top = shelfY - it.hMm * k;
            // From the footprint's edge nearest the side view.
            const from = vy(at(it).v);
            const cls = `shelf-room__guide${lit ? ' shelf-room__guide--lit' : ''}`;
            return (
              <g key={`guide-${it.id}`} className={cls} aria-hidden="true" data-guide-for={it.id}>
                <path d={`M ${x} ${from} V ${top} M ${x + w} ${from} V ${top}`} />
              </g>
            );
          })}
          {/* Things further from the viewer are drawn first, so what is nearer covers them. The order is the
              saved one, not the dragged one: moving an element in the page mid-drag would drop the pointer. */}
          {[...items].sort((a, b) => at(b).v - at(a).v).map((saved) => shown.find((s) => s.id === saved.id)!).map((it) => {
            const o = byId.get(it.id);
            if (o == null) return null;
            const x = boxX(it);
            const w = at(it).uw * k;
            const h = it.hMm * k;
            const y = shelfY - h;
            const isSelected = selected?.kind === 'occupant' && selected.id === o.id;
            const lit = isSelected || hover === o.id;
            const isDevice = o.kind === 'chassis';
            const facePorts = portsOnFace(o, face).length;
            const elsewhere = SHELF_FACES.filter((f) => f !== face && portsOnFace(o, f).length > 0).map((f) => FACE_SHORT[f]);
            const behind = hiddenBehind(it, shown.filter((s) => s.id !== it.id), face);
            const ai = aiWord(o);
            const handlers = (from: 'front' | 'plan') => ({
              onPointerDown: (e: ReactPointerEvent) => onDown(e, it, from),
              onPointerMove: (e: ReactPointerEvent) => onMove(e, it),
              onPointerUp: () => onUp(it),
              onPointerCancel: () => setDrag(null),
              onPointerEnter: () => setHover(o.id),
              onPointerLeave: () => setHover((h) => (h === o.id ? null : h)),
              onClick: (e: ReactMouseEvent) => {
                e.stopPropagation();
                select({ kind: 'occupant', id: o.id });
              },
              onDoubleClick: (e: ReactMouseEvent) => {
                e.stopPropagation();
                if (isDevice) onOpenDevice(o.id);
              },
            });
            const cls = (extra: string) =>
              ['shelf-room__thing', extra, isSelected ? 'shelf-room__thing--selected' : '', lit && !isSelected ? 'shelf-room__thing--lit' : '', it.over ? 'shelf-room__thing--over' : '', onArrange != null ? 'shelf-room__thing--movable' : '', behind ? 'shelf-room__thing--set-back' : '', ai != null ? 'shelf-room__thing--ai' : '']
                .filter(Boolean)
                .join(' ');
            // A dashed edge says the size is estimated from its ports; a solid one is the maker's.
            const boxCls = `shelf-room__box${it.sized ? '' : ' shelf-room__box--guess'}`;
            const py = planBoxY(it);
            const ph = at(it).vd * kd;
            const secondLine = o.model ?? 'typed by hand';
            const backLine = it.yMm > 0 ? `${Math.round(it.yMm)} mm back` : null;
            const portsNote = facePorts === 0 && elsewhere.length > 0 ? (w > 130 ? `ports on the ${listed(elsewhere)}` : `ports: ${elsewhere.join(', ')}`) : null;
            return (
              <g key={o.id}>
                <g className={cls('shelf-room__thing--plan')} data-plan-id={o.id} {...handlers('plan')}>
                  <rect className={boxCls} x={x} y={py} width={w} height={ph} />
                  {ph > 16 && w > 30 ? (
                    <text className="shelf-room__label" x={x + 5} y={py + 13}>
                      {o.label || 'unnamed'}
                    </text>
                  ) : null}
                </g>
                <g
                  className={cls('')}
                  data-occupant-id={o.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`${o.label || 'unnamed'}${it.yMm > 0 ? `, ${Math.round(it.yMm)} mm back` : ''}${isSelected ? ', selected' : ''}`}
                  {...handlers('front')}
                  onKeyDown={(e) => onKey(e, it, o)}
                >
                  <rect className={boxCls} x={x} y={y} width={w} height={h} />
                  <text className="shelf-room__label" x={x + 6} y={y + 14}>
                    {o.label || 'unnamed'}
                  </text>
                  {h > 36 ? (
                    <text className="shelf-room__mono" x={x + 6} y={y + 27}>
                      {secondLine}
                    </text>
                  ) : null}
                  {backLine != null && !sideways ? (
                    <text className="shelf-room__mono" x={x + 6} y={h > 50 ? y + 40 : y - 6}>
                      {backLine}
                    </text>
                  ) : null}
                  {portsNote != null ? (
                    <text className="shelf-room__mono" x={x + w - 6} y={shelfY - 8} textAnchor="end">
                      {portsNote}
                    </text>
                  ) : null}
                  {it.over ? (
                    <text className="shelf-room__mono" x={x + 6} y={y - 6}>
                      does not fit
                    </text>
                  ) : null}
                  {ai != null ? (
                    <text className="shelf-room__ai-tag" x={x + w - 4} y={y - 6} textAnchor="end">
                      {ai}
                    </text>
                  ) : null}
                </g>
              </g>
            );
          })}
          {measure != null ? <Measure a={measure.a} b={measure.b} label={measure.label} y={frontTop - 34} shelfY={shelfY} /> : null}
          {draggingItem != null && drag?.from === 'plan' && !sideways ? (
            <DepthMeasure
              x={boxX(draggingItem) + (at(draggingItem).uw * k) / 2}
              lipY={face === 'front' ? planBottom : planTop}
              edgeY={face === 'front' ? vy(at(draggingItem).v) : vy(at(draggingItem).v + at(draggingItem).vd)}
              farY={face === 'front' ? planBoxY(draggingItem) : vy(at(draggingItem).v)}
              yMm={draggingItem.yMm}
            />
          ) : null}
          {hangs.map((h) => (
            <HangingCable key={h.id} {...h} />
          ))}
          {pendingSpot != null && pointer != null ? <path className="shelf-room__rubber" d={`M ${pendingSpot.x} ${pendingSpot.y} L ${pointer.x} ${pointer.y}`} aria-hidden="true" /> : null}
          {portSpots.map((s) => {
            const isSelected = selected?.kind === 'port' && selected.id === s.port.id;
            const cabled = s.port.cable != null;
            const size = s.size;
            const isPending = pending === s.port.id;
            const isTarget = pending != null && !isPending && !cabled;
            return (
              <rect
                key={s.port.id}
                data-port-id={s.port.id}
                className={['shelf-room__port', cabled ? 'shelf-room__port--cabled' : '', isSelected ? 'shelf-room__port--selected' : '', isPending ? 'shelf-room__port--pending' : '', isTarget ? 'shelf-room__port--target' : '']
                  .filter(Boolean)
                  .join(' ')}
                x={s.x - size / 2}
                y={s.y - size * 0.4}
                width={size}
                height={size * 0.8}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => onPortClick(e, s.port)}
              >
                <title>{`${s.port.label}${cabled ? '' : onConnect != null ? ' (free: click to run a cable from it)' : ' (free)'}`}</title>
              </rect>
            );
          })}
          {tagsOf(hangs).map((h) =>
            h.tag != null ? (
              <g key={`tag-${h.id}`} className="shelf-room__tag">
                <rect x={h.b.x < x0 ? h.b.x - 6 : h.b.x - h.tag.length * 6.2 - 2} y={h.up ? h.b.y - 22 : h.b.y + 6} width={h.tag.length * 6.2 + 8} height={16} />
                <text className="shelf-room__mono" x={h.b.x < x0 ? h.b.x - 2 : h.b.x - h.tag.length * 6.2 + 2} y={h.up ? h.b.y - 10 : h.b.y + 18}>
                  {h.tag}
                </text>
              </g>
            ) : null,
          )}
        </svg>
        {refusal != null ? (
          <p className="shelf-room__refusal" role="alert">
            {refusal}
          </p>
        ) : null}
        <p className="shelf-room__hint">
          The strip is the shelf seen from above, the drawing under it the same shelf from one side: each thing is in both, joined by dashed lines, and pointing at one lights the other. Front, Right, Back and Left walk round it. A dashed box is a size guessed from its ports; a solid one is the maker's.{' '}
          {onArrange != null
            ? 'Drag a thing in either drawing; it stops against its neighbours and its cables follow. Arrow keys move the selected one 10 mm (Shift: 1 mm). Click a free port, then the port at the other end, to run a cable. Double-click a device to open it and add ports. Esc goes back to the rack.'
            : 'Click a thing to see it in the panel. Double-click a device to open it. Esc goes back to the rack.'}
        </p>
      </div>
    </div>
  );
}

/** One tag for each run of cables to the same place down the same post: the last one's end, with a count. */
function tagsOf<T extends { id: string; b: Pt; tag: string | null }>(hangs: readonly T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const h of hangs) {
    if (h.tag == null) continue;
    const key = `${h.tag}|${h.b.x > 0 ? Math.round(h.b.x / 40) : 0}`;
    groups.set(key, [...(groups.get(key) ?? []), h]);
  }
  return [...groups.values()].map((g) => {
    const last = g[g.length - 1]!;
    return g.length > 1 ? { ...last, tag: `${last.tag} ×${g.length}` } : last;
  });
}

/** One cable hanging between two points, swinging back to rest after either end moves. */
function HangingCable({ id, a, b, slack, stroke, obstacles, ai }: { id: string; a: Pt; b: Pt; slack: number; stroke: string; obstacles: Obstacle[]; ai: boolean }): JSX.Element {
  const sway = useCableSway(id, true, a.x, a.y, b.x, b.y);
  const { d } = hangCable({ a: { ...a, dir: 1 }, b, slack, sway, ...(obstacles.length > 0 ? { obstacles } : {}) });
  return <path className={`shelf-room__cable${ai ? ' shelf-room__cable--ai' : ''}`} d={d} style={{ stroke }} data-ai={ai ? 'adds' : undefined} />;
}

/** While dragging in the strip: how far the thing's front face is back from the shelf's lip, measured
 * in the gap the drag has just opened (nothing else is there), or past the thing when that gap is too small. */
function DepthMeasure({ x, lipY, edgeY, farY, yMm }: { x: number; lipY: number; edgeY: number; farY: number; yMm: number }): JSX.Element {
  const label = `${Math.round(yMm)} mm back`;
  const w = label.length * 6.2 + 8;
  const roomy = Math.abs(edgeY - lipY) >= 20;
  const mid = roomy ? (lipY + edgeY) / 2 : farY + (farY < lipY ? -12 : 12);
  return (
    <g className="shelf-room__measure" aria-hidden="true">
      <path d={`M ${x} ${lipY} V ${edgeY} M ${x - 4} ${lipY} H ${x + 4} M ${x - 4} ${edgeY} H ${x + 4}`} />
      <rect x={x - w / 2} y={mid - 8} width={w} height={16} />
      <text className="shelf-room__mono" x={x} y={mid + 4} textAnchor="middle">
        {label}
      </text>
    </g>
  );
}

/** While dragging: a distance across the side view, from `a` to the thing's edge at `b`, dropped to the shelf. */
function Measure({ a, b, label, y, shelfY }: { a: number; b: number; label: string; y: number; shelfY: number }): JSX.Element {
  const w = Math.max(56, label.length * 6.2 + 8);
  return (
    <g className="shelf-room__measure" aria-hidden="true">
      <path d={`M ${a} ${y} H ${b} M ${a} ${y - 4} V ${y + 4} M ${b} ${y - 4} V ${shelfY}`} />
      <rect x={(a + b) / 2 - w / 2} y={y - 8} width={w} height={16} />
      <text className="shelf-room__mono" x={(a + b) / 2} y={y + 4} textAnchor="middle">
        {label}
      </text>
    </g>
  );
}
