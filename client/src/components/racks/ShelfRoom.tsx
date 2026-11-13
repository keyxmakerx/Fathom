// Sign-off shelf-view (answer C, both): stepping into a shelf draws it twice, lined up: a strip seen
// from above, over the shelf seen from the front between the rack's posts, both to scale (the strip
// at half depth). Each thing sits where it really is: along the shelf (SitsOn.x_mm) and back from
// the lip (SitsOn.y_mm). Drag it left or right in either view, or back and forward in the strip; it
// stops against its neighbours and its cables follow and settle. Dashed lines join each thing's two
// drawings, and pointing at either lights both, so the two read as one shelf (the owner's note,
// "make it more obvious").
// Back turns the shelf round to show rear ports. A cable between two things on the shelf hangs
// between their ports; one that leaves the shelf runs down the nearer post with a tag naming its
// far end. A click selects (the panel beside shows it), a double-click on a device opens it, and
// the bar's path and Esc lead back out, as before (sign-off r63).
import { useEffect, useMemo, useRef, useState, type JSX, type RefObject, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from 'react';

import type { ClosetView, OccupantView, PortView } from '../../document/view';
import type { Selection } from '../drawing/contract';
import { hangCable, type Obstacle, type Pt } from '../drawing/cablePhysics';
import { useCableSway } from '../drawing/cableShape';
import { findShelf } from '../drawing/lookup';
import { SHEATH_VAR } from '../drawing/sheath';
import { deviceChassis } from '../jot/jotLayout';
import { SHELF_DEPTH_MM, SHELF_INSIDE_MM, dropOnPlan, dropSpot, layoutShelf, portsOnFace, rowOf, type ShelfFace, type ShelfItem } from './shelfLayout';
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
/** The strip seen from above is drawn at this share of the front view's scale front to back, so
 * both fit on one screen; its label says so. Along the shelf the two share one scale and line up. */
const DEPTH_SCALE = 0.5;
const PLAN_TOP_PX = 44;
/** The drawing's height that does not grow with the scale (labels, the cables' drop, the hint), and the
 * height of a typical thing on a shelf, for fitting the drawing to the stage. */
const FIXED_HEIGHT_PX = 470;
const TYPICAL_TALL_MM = 50;
/** The room between the strip and the front view, for the front view's label and the measure. */
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

interface PortSpot {
  port: PortView;
  occupantId: string;
  x: number;
  y: number;
  size: number;
}

export function ShelfRoom({ view, shelfId, selected, paused, onSelect, onOpenDevice, onBack, onArrange }: ShelfRoomProps): JSX.Element {
  const found = findShelf(view, shelfId);
  const [stageRef, k] = useScale();
  const [face, setFace] = useState<ShelfFace>('front');
  const [snap, setSnap] = useState(true);
  const [drag, setDrag] = useState<{
    id: string;
    /** Which drawing it was picked up in: the front view moves it along, the strip either way. */
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (paused || focusInField() || e.key !== 'Escape' || e.defaultPrevented) return;
      onBack();
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paused, onBack]);

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

  // Geometry, in pixels. Looking from behind, left and right swap.
  const widestRight = Math.max(SHELF_INSIDE_MM, ...shown.map((it) => it.xMm + it.wMm));
  const tallest = Math.max(40, ...shown.map((it) => it.hMm));
  const x0 = MARGIN_PX;
  const W = SHELF_INSIDE_MM * k;
  const kd = k * DEPTH_SCALE;
  const deepest = Math.max(SHELF_DEPTH_MM, ...shown.map((it) => it.yMm + it.dMm));
  const planTop = PLAN_TOP_PX + (deepest - SHELF_DEPTH_MM) * kd;
  const planH = SHELF_DEPTH_MM * kd;
  const planBottom = planTop + planH;
  const frontTop = planBottom + BETWEEN_PX;
  const shelfY = frontTop + DROP_PX * 0.6 + tallest * k;
  const svgW = x0 + widestRight * k + MARGIN_PX;
  const svgH = shelfY + DROP_PX + 70;
  // In the strip the shelf's front lip is nearest the front view (at the bottom); from behind, the back is.
  const lipY = face === 'front' ? planBottom : planTop;
  const planBoxY = (it: ShelfItem) => (face === 'front' ? planBottom - (it.yMm + it.dMm) * kd : planTop + it.yMm * kd);
  const planFrontEdgeY = (it: ShelfItem) => (face === 'front' ? planBottom - it.yMm * kd : planTop + it.yMm * kd);
  const boxX = (it: ShelfItem) => (face === 'front' ? x0 + it.xMm * k : x0 + (SHELF_INSIDE_MM - it.xMm - it.wMm) * k);

  const portSpots: PortSpot[] = [];
  for (const it of shown) {
    const o = byId.get(it.id);
    if (o == null) continue;
    const ports = portsOnFace(o, face);
    if (ports.length === 0) continue;
    const rows = ports.length > 24 ? 2 : 1;
    const perRow = Math.ceil(ports.length / rows);
    const w = it.wMm * k;
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
      hangs.push({ id: cable.cableId, a, b, slack: 0.3, stroke, tag: null, up: false, obstacles: [] });
      continue;
    }
    const onShelfBehind = cable.farChassisId != null && byId.has(cable.farChassisId);
    const left = s.x < x0 + W / 2;
    // A cable to a device racked above the shelf climbs the post; every other one drops down it.
    const farRacked = cable.farChassisId != null ? rack.chassis.find((c) => c.id === cable.farChassisId) : undefined;
    const up = farRacked != null && farRacked.positionU > shelf.positionU;
    const lane = leaving.filter((l) => l.left === left && l.up === up).length;
    const postX = left ? x0 - POST_PX / 2 - 8 : x0 + W + 8 + POST_PX / 2;
    const b = { x: postX + (left ? 1 : -1) * (lane % 2 === 0 ? 0 : 4), y: up ? frontTop + 40 + lane * POST_LANE_PX : shelfY + DROP_PX + lane * POST_LANE_PX };
    const name = farName(cable.farChassisId);
    const tag = onShelfBehind
      ? `to ${name ?? 'this shelf'}, ${face === 'front' ? 'at the back' : 'at the front'}`
      : `to ${name ?? (cable.outsideCloset ? 'another closet' : '—')}${up ? ', above' : ''}`;
    leaving.push({ left, up });
    hangs.push({ id: cable.cableId, a, b, slack: up ? 0.04 : 0.12, stroke, tag, up, obstacles: [] });
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
    const wantX = drag.startX + (face === 'front' ? dxPx : -dxPx) / k;
    const doSnap = snap && !e.altKey;
    if (drag.from === 'front') {
      const x = dropSpot(rowOf(others(it.id), it), it.wMm, wantX, doSnap) ?? drag.x;
      setDrag({ ...drag, x, moved });
      return;
    }
    // In the strip, up is further back when looking from the front, and further forward from behind.
    const wantY = drag.startY + (face === 'front' ? -dyPx : dyPx) / kd;
    const spot = dropOnPlan(others(it.id), it, wantX, wantY, doSnap);
    setDrag({ ...drag, ...(spot != null ? { x: spot.xMm, y: spot.yMm } : {}), moved });
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
    if (e.key === 'Enter' && isDevice) onOpenDevice(o.id);
    else if (e.key === ' ') select({ kind: 'occupant', id: o.id });
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && onArrange != null) {
      const dx = step * (e.key === 'ArrowRight' ? 1 : -1) * (face === 'front' ? 1 : -1);
      const x = dropSpot(rowOf(others(it.id), it), it.wMm, it.xMm + dx, false);
      if (x != null && x !== it.xMm) commit(it.id, x, it.yMm);
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && onArrange != null) {
      // Up in the strip: further back from the front, further forward from behind.
      const dy = step * (e.key === 'ArrowUp' ? 1 : -1) * (face === 'front' ? 1 : -1);
      const spot = dropOnPlan(others(it.id), it, it.xMm, it.yMm + dy, false);
      if (spot != null && (spot.xMm !== it.xMm || spot.yMm !== it.yMm)) commit(it.id, spot.xMm, spot.yMm);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const draggingItem = drag != null && drag.moved ? shown.find((it) => it.id === drag.id) : undefined;

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
          <button type="button" className="shelf-room__tool" aria-pressed={face === 'front'} onClick={() => setFace('front')}>
            Front
          </button>
          <button type="button" className="shelf-room__tool" aria-pressed={face === 'rear'} onClick={() => setFace('rear')}>
            Back
          </button>
          {onArrange != null ? (
            <button type="button" className="shelf-room__tool" aria-pressed={snap} onClick={() => setSnap((s) => !s)} title="Snap to neighbours and 10 mm steps. Hold Alt while dragging to place freely.">
              Snap: {snap ? 'on' : 'off'}
            </button>
          ) : null}
        </span>
      </div>
      <div className="shelf-room__stage" ref={stageRef}>
        {occupants.length === 0 ? <div className="shelf-room__empty">Nothing on this shelf yet.</div> : null}
        <svg className="shelf-room__svg" width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`} role="img" aria-label={`${shelf.label || 'Shelf'} from the ${face === 'front' ? 'front' : 'back'}`}>
          <defs>
            <pattern id="shelf-room-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" className="shelf-room__hatch-line" />
            </pattern>
          </defs>
          {/* The strip seen from above: the shelf's tray, its lip nearest the front view. */}
          <g className="shelf-room__plan" aria-hidden="true">
            <text className="shelf-room__mono shelf-room__view-label" x={x0} y={planTop - 12}>
              FROM ABOVE{onArrange != null ? ' · drag to set how far back' : ''} · drawn at half depth
            </text>
            <rect className="shelf-room__plan-tray" x={x0} y={planTop} width={W} height={planH} />
            <rect className="shelf-room__plan-lip" x={x0} y={lipY - 1.5} width={W} height={3} />
            <text className="shelf-room__mono" x={x0 - 8} y={lipY + 4} textAnchor="end">
              FRONT
            </text>
            <text className="shelf-room__mono" x={x0 - 8} y={(face === 'front' ? planTop : planBottom) + 4} textAnchor="end">
              BACK
            </text>
          </g>
          <text className="shelf-room__mono shelf-room__view-label" x={x0} y={frontTop - 10} aria-hidden="true">
            FROM THE {face === 'front' ? 'FRONT' : 'BACK'}
            {onArrange != null ? ' · drag left or right' : ''}
          </text>
          {/* The rack's posts, and the shelf's tray with its front lip. */}
          <rect className="shelf-room__post" x={x0 - POST_PX - 8} y={frontTop - 4} width={POST_PX} height={svgH - frontTop - 4} />
          <rect className="shelf-room__post" x={x0 + W + 8} y={frontTop - 4} width={POST_PX} height={svgH - frontTop - 4} />
          <rect className="shelf-room__tray" x={x0 - 8} y={shelfY} width={W + 16} height={10} />
          <rect className="shelf-room__lip" x={x0 - 8} y={shelfY + 10} width={W + 16} height={3} />
          <text className="shelf-room__mono" x={x0 + W} y={shelfY + 28} textAnchor="end">
            {face === 'front' ? 'FRONT' : 'BACK'} · {SHELF_INSIDE_MM} MM INSIDE
          </text>
          {/* The lines that join each thing's two drawings: faint always, dark for the one pointed at or selected. */}
          {shown.map((it) => {
            const lit = hover === it.id || (selected?.kind === 'occupant' && selected.id === it.id);
            const x = boxX(it);
            const w = it.wMm * k;
            const top = shelfY - it.hMm * k;
            // From the footprint's edge nearest the front view: its front from the front, its back from behind.
            const from = planBoxY(it) + it.dMm * kd;
            const cls = `shelf-room__guide${lit ? ' shelf-room__guide--lit' : ''}`;
            return (
              <g key={`guide-${it.id}`} className={cls} aria-hidden="true" data-guide-for={it.id}>
                <path d={`M ${x} ${from} V ${top} M ${x + w} ${from} V ${top}`} />
              </g>
            );
          })}
          {/* Things set further back are drawn first, so what is in front covers them. The order is the
              saved one, not the dragged one: moving an element in the page mid-drag would drop the pointer. */}
          {[...items].sort((a, b) => (face === 'front' ? b.yMm - a.yMm : a.yMm - b.yMm)).map((saved) => shown.find((s) => s.id === saved.id)!).map((it) => {
            const o = byId.get(it.id);
            if (o == null) return null;
            const x = boxX(it);
            const w = it.wMm * k;
            const h = it.hMm * k;
            const y = shelfY - h;
            const isSelected = selected?.kind === 'occupant' && selected.id === o.id;
            const lit = isSelected || hover === o.id;
            const isDevice = o.kind === 'chassis';
            const facePorts = portsOnFace(o, face).length;
            const otherFace = portsOnFace(o, face === 'front' ? 'rear' : 'front').length;
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
              ['shelf-room__thing', extra, isSelected ? 'shelf-room__thing--selected' : '', lit && !isSelected ? 'shelf-room__thing--lit' : '', it.over ? 'shelf-room__thing--over' : '', onArrange != null ? 'shelf-room__thing--movable' : '', face === 'front' && it.yMm > 0 ? 'shelf-room__thing--set-back' : '']
                .filter(Boolean)
                .join(' ');
            // A dashed edge says the size is estimated from its ports; a solid one is the maker's.
            const boxCls = `shelf-room__box${it.sized ? '' : ' shelf-room__box--guess'}`;
            const py = planBoxY(it);
            const ph = it.dMm * kd;
            const secondLine = o.model ?? 'typed by hand';
            const backLine = it.yMm > 0 ? `${Math.round(it.yMm)} mm back` : null;
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
                  {backLine != null ? (
                    <text className="shelf-room__mono" x={x + 6} y={h > 50 ? y + 40 : y - 6}>
                      {backLine}
                    </text>
                  ) : null}
                  {facePorts === 0 && otherFace > 0 ? (
                    <text className="shelf-room__mono" x={x + w - 6} y={shelfY - 8} textAnchor="end">
                      {w > 130 ? `ports on the ${face === 'front' ? 'back' : 'front'}` : face === 'front' ? 'ports: back' : 'ports: front'}
                    </text>
                  ) : null}
                  {it.over ? (
                    <text className="shelf-room__mono" x={x + 6} y={y - 6}>
                      does not fit
                    </text>
                  ) : null}
                </g>
              </g>
            );
          })}
          {draggingItem != null && drag?.from === 'front' ? <Measure x0={x0} k={k} item={draggingItem} face={face} y={frontTop - 34} shelfY={shelfY} /> : null}
          {draggingItem != null && drag?.from === 'plan' ? (
            <DepthMeasure x={boxX(draggingItem) + (draggingItem.wMm * k) / 2} lipY={lipY} edgeY={planFrontEdgeY(draggingItem)} farY={face === 'front' ? planBoxY(draggingItem) : planBoxY(draggingItem) + draggingItem.dMm * kd} yMm={draggingItem.yMm} />
          ) : null}
          {hangs.map((h) => (
            <HangingCable key={h.id} {...h} />
          ))}
          {portSpots.map((s) => {
            const isSelected = selected?.kind === 'port' && selected.id === s.port.id;
            const cabled = s.port.cable != null;
            const size = s.size;
            return (
              <rect
                key={s.port.id}
                data-port-id={s.port.id}
                className={['shelf-room__port', cabled ? 'shelf-room__port--cabled' : '', isSelected ? 'shelf-room__port--selected' : ''].filter(Boolean).join(' ')}
                x={s.x - size / 2}
                y={s.y - size * 0.4}
                width={size}
                height={size * 0.8}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  select({ kind: 'port', id: s.port.id });
                }}
              >
                <title>{`${s.port.label}${cabled ? '' : ' (free)'}`}</title>
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
          The strip is the shelf seen from above, the drawing under it the same shelf from the front: each thing is in both, joined by dashed lines, and pointing at one lights the other. A dashed box is a size guessed from its ports; a solid one is the maker's.{' '}
          {onArrange != null
            ? 'Drag a thing left or right in either, or back and forward in the strip; it stops against its neighbours and its cables follow. Arrow keys move the selected one 10 mm (Shift: 1 mm). Double-click a device to open it. Esc goes back to the rack.'
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
function HangingCable({ id, a, b, slack, stroke, obstacles }: { id: string; a: Pt; b: Pt; slack: number; stroke: string; obstacles: Obstacle[] }): JSX.Element {
  const sway = useCableSway(id, true, a.x, a.y, b.x, b.y);
  const { d } = hangCable({ a: { ...a, dir: 1 }, b, slack, sway, ...(obstacles.length > 0 ? { obstacles } : {}) });
  return <path className="shelf-room__cable" d={d} style={{ stroke }} />;
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

/** While dragging: how far the thing's left side is from the shelf's left edge, as you look at it. */
function Measure({ x0, k, item, face, y, shelfY }: { x0: number; k: number; item: ShelfItem; face: ShelfFace; y: number; shelfY: number }): JSX.Element {
  const fromLeft = face === 'front' ? item.xMm : SHELF_INSIDE_MM - item.xMm - item.wMm;
  const edge = x0 + fromLeft * k;
  const label = `${Math.round(fromLeft)} mm`;
  return (
    <g className="shelf-room__measure" aria-hidden="true">
      <path d={`M ${x0} ${y} H ${edge} M ${x0} ${y - 4} V ${y + 4} M ${edge} ${y - 4} V ${shelfY}`} />
      <rect x={(x0 + edge) / 2 - 28} y={y - 8} width={56} height={16} />
      <text className="shelf-room__mono" x={(x0 + edge) / 2} y={y + 4} textAnchor="middle">
        {label}
      </text>
    </g>
  );
}
