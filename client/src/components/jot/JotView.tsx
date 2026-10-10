// ADR-0060 decision 10, "jot mode": a device opened onto the canvas. It is drawn large with its ports in
// free space, equipment dropped beside it, and cables run port to port. The bar and panels stay; Esc or the
// bar's path leads back out. Inside (virtual machines, zones) is one level further in.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

import { snap } from '../../document/freeform';
import type { ChassisView, ClosetView } from '../../document/view';
import { PORT_GLYPHS } from '../ports';
import { portKindFor } from '../drawing/portGlyph';
import type { Selection } from '../drawing/contract';
import { connectorName } from '../drawing/faceplate';
import { decodePaletteDrag, PALETTE_DRAG_MIME } from '../drawing/dnd';
import { SHEATH_VAR } from '../drawing/sheath';
import { boundsOf, jotPlates, portCentre, type JotPlate } from './jotLayout';
import type { PortPlace, TemplatePort } from '../../document/plate';
import type { PortBox } from '../drawing/faceplate';
import { PlateTools } from './PlateTools';
import { ALIGN_PX, PLATE_GRID, snapPort, toPlate, type SnappedPort } from './portArrange';
import './jot.css';

/** The port kinds the tray offers, dragged onto a plate or clicked. */
const TRAY_CONNECTORS = ['rj45', 'sfp_plus', 'sfp28', 'qsfp28', 'lc'] as const;
const PORT_DRAG_MIME = 'application/x-fathom-port-kind';

export interface JotViewProps {
  view: ClosetView;
  deviceId: string;
  /** The device's place on the full canvas, so a dropped box lands beside it there. */
  origin: { x: number; y: number };
  canDraw: boolean;
  selected: Selection | null;
  litPortLabel: string | null;
  startInside: boolean;
  onSelect: (selection: Selection | null) => void;
  onBack: () => void;
  onAddBox: (role: string | null, x: number, y: number, fromBoxId?: string, model?: { vendor: string; model: string }) => void;
  onMoveBox: (id: string, x: number, y: number) => void;
  onConnect: (fromPortId: string, toPortId: string) => void;
  onDisconnect: (cableId: string) => void;
  onRemoveBox: (id: string) => void;
  /** A hand-typed port of `connector` on a box with no catalogue model. */
  onAddPort: (chassisId: string, connector: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  /** Bumped by the bar's fit button: back to the fitted size. */
  fitRequest: number;
  /** A card is open over this view: it takes the keys. */
  paused: boolean;
  renderConfigDrawer?: (chassis: ChassisView) => ReactNode;
  renderInsideStop?: (chassis: ChassisView) => ReactNode;
  /** Schema 0.19: hand-typed ports dragged to new spots, in thousandths of the plate. Absent: ports stay put. */
  onPlacePorts?: (chassisId: string, places: PortPlace[]) => void;
  /** Every dragged port on a box back in the usual order. */
  onResetPorts?: (chassisId: string) => void;
  /** Whose saved faceplates to offer; `undefined` leaves templates out. */
  templateOwner?: string | null;
  /** Adds a template's ports to an empty hand-typed box, one undo step. */
  onApplyTemplate?: (chassisId: string, ports: readonly TemplatePort[]) => void;
}

/** A port being dragged on its plate: where it would settle now, and the guides it lines up on. */
interface PortDrag extends SnappedPort {
  plateId: string;
  portId: string;
  /** Where the pointer has the port's centre now, kept on the plate; it snaps to `cx`/`cy` on drop. */
  px: number;
  py: number;
}

/** A port moves only on a hand-typed box, and only if it is not a catalogue port. */
function movable(plate: JotPlate, portId: string): boolean {
  if (plate.chassis.model !== '') return false;
  const port = plate.chassis.ports.find((p) => p.id === portId);
  return port !== undefined && port.rowKind === undefined;
}

interface Pt {
  x: number;
  y: number;
}

const MAX_K = 5;
const MIN_K = 0.5;

function focusInField(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLElement && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName));
}

export function JotView(props: JotViewProps): JSX.Element {
  const { view, deviceId, origin, canDraw, selected, litPortLabel, startInside, onSelect, onBack, onAddBox, onMoveBox, onConnect, onDisconnect, onRemoveBox, onAddPort, onUndo, onRedo, fitRequest, paused, renderConfigDrawer, renderInsideStop } = props;
  const { onPlacePorts, onResetPorts, templateOwner, onApplyTemplate } = props;
  const [arranging, setArranging] = useState(false);
  const [portDrag, setPortDrag] = useState<PortDrag | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  const [zoomBy, setZoomBy] = useState(1);
  const [showConfig, setShowConfig] = useState(false);
  const [inside, setInside] = useState(startInside);
  const [moving, setMoving] = useState<{ id: string; at: Pt } | null>(null);
  const [hoverPort, setHoverPort] = useState<string | null>(null);
  const [wire, setWire] = useState<{ from: string; a: Pt; to: Pt } | null>(null);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => setZoomBy(1), [fitRequest]);

  const plates = useMemo(() => jotPlates(view, deviceId, origin), [view, deviceId, origin]);
  const shown = useMemo<JotPlate[]>(
    () => (plates ?? []).map((p) => (moving?.id === p.chassis.id ? { ...p, x: moving.at.x, y: moving.at.y } : p)),
    [plates, moving],
  );
  const device = shown.find((p) => p.isDevice)?.chassis;

  const bounds = boundsOf(shown.length > 0 ? shown : []);
  const room = size.h * (showConfig ? 0.45 : 0.75);
  const fitAll = shown.length === 0 ? 1 : Math.min((size.w * 0.9) / bounds.w, room / bounds.h, MAX_K);
  const fit = fitAll;
  const k = Math.max(MIN_K, Math.min(MAX_K, fit * zoomBy));
  const left = (size.w - bounds.w * k) / 2 - bounds.x * k;
  const top = Math.max(48, (size.h * (showConfig ? 0.5 : 0.9) - bounds.h * k) / 2) - bounds.y * k;

  const toStage = useCallback(
    (clientX: number, clientY: number): Pt => {
      const r = stageRef.current?.getBoundingClientRect();
      return r ? { x: (clientX - r.left) / k, y: (clientY - r.top) / k } : { x: 0, y: 0 };
    },
    [k],
  );

  // Keys: Esc leaves, Delete removes the selected cable or box, Ctrl Z undoes (the canvas's own keys).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (paused || focusInField()) return;
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return; // Checks took this one
        if (inside) setInside(false);
        else onBack();
        e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (canDraw) (e.shiftKey ? onRedo : onUndo)();
        e.preventDefault();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && canDraw && selected) {
        if (selected.kind === 'cable') onDisconnect(selected.id);
        else if (selected.kind === 'chassis' && selected.id !== deviceId && shown.some((p) => p.chassis.id === selected.id)) onRemoveBox(selected.id);
        else return;
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paused, inside, onBack, onUndo, onRedo, onDisconnect, onRemoveBox, canDraw, selected, deviceId, shown]);

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    setZoomBy((z) => Math.max(0.3, Math.min(6, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
  };

  const onDrop = (e: React.DragEvent) => {
    if (!canDraw) return;
    const payload = decodePaletteDrag(e.dataTransfer.getData(PALETTE_DRAG_MIME));
    if (!payload) return;
    e.preventDefault();
    const at = toStage(e.clientX, e.clientY);
    onAddBox(payload.role ?? null, origin.x + at.x - 64, origin.y + at.y - 28, undefined, payload.role === undefined ? { vendor: payload.vendor, model: payload.model } : undefined);
  };

  // A cable: press a port, drag, release on another port.
  const startWire = (e: ReactPointerEvent, plate: JotPlate, portId: string) => {
    e.stopPropagation();
    if (!canDraw) return;
    const a = portCentre(plate, portId);
    if (!a) return;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    setWire({ from: portId, a, to: a });
  };
  const moveWire = (e: ReactPointerEvent) => {
    if (wire) setWire({ ...wire, to: toStage(e.clientX, e.clientY) });
  };
  const endWire = (e: ReactPointerEvent) => {
    if (!wire) return;
    const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-jot-port]');
    const to = hit?.dataset.jotPort;
    setWire(null);
    if (to && to !== wire.from) onConnect(wire.from, to);
  };

  // A box moves by its name.
  const startMove = (e: ReactPointerEvent, plate: JotPlate) => {
    onSelect({ kind: 'chassis', id: plate.chassis.id });
    if (!canDraw || plate.isDevice) return;
    e.stopPropagation();
    const grab = toStage(e.clientX, e.clientY);
    const start = { x: plate.x, y: plate.y };
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const p = toStage(ev.clientX, ev.clientY);
      setMoving({ id: plate.chassis.id, at: { x: start.x + p.x - grab.x, y: start.y + p.y - grab.y } });
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      const p = toStage(ev.clientX, ev.clientY);
      const x = start.x + p.x - grab.x;
      const y = start.y + p.y - grab.y;
      setMoving(null);
      if (Math.abs(x - start.x) + Math.abs(y - start.y) > 2) onMoveBox(plate.chassis.id, snap(origin.x + x), snap(origin.y + y));
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  // Arranging (schema 0.19): press a hand-typed port and drag it anywhere on its plate. It snaps to
  // the grid, or lines up with another port when it comes close; the drop is one undo step.
  const othersOn = (plate: JotPlate, portId: string) =>
    plate.layout.boxes.filter((b) => b.id !== portId).map((b) => ({ id: b.id, cx: b.x + b.w / 2, cy: b.y + b.h / 2 }));
  const startPortDrag = (e: ReactPointerEvent, plate: JotPlate, box: PortBox) => {
    e.stopPropagation();
    if (!canDraw || !onPlacePorts) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const grab = toStage(e.clientX, e.clientY);
    const start = { cx: box.x + box.w / 2, cy: box.y + box.h / 2 };
    const dims = { w: plate.w, h: plate.h };
    const others = othersOn(plate, box.id);
    const within = Math.max(1.5, (ALIGN_PX * 2) / k);
    let last: SnappedPort | null = null;
    const move = (ev: PointerEvent) => {
      const p = toStage(ev.clientX, ev.clientY);
      const raw = { cx: start.cx + p.x - grab.x, cy: start.cy + p.y - grab.y };
      last = snapPort(raw, box, dims, others, within);
      const keep = (v: number, half: number, span: number) => Math.max(half, Math.min(span - half, v));
      setPortDrag({ plateId: plate.chassis.id, portId: box.id, ...last, px: keep(raw.cx, box.w / 2, dims.w), py: keep(raw.cy, box.h / 2, dims.h) });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setPortDrag(null);
      const at = last;
      if (at && Math.abs(at.cx - start.cx) + Math.abs(at.cy - start.cy) > 0.5) onPlacePorts(plate.chassis.id, [{ portId: box.id, ...toPlate(at.cx, at.cy, dims) }]);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  // The keyboard way to arrange: arrows move a port one grid step, Shift four.
  const nudgePort = (e: React.KeyboardEvent, plate: JotPlate, box: PortBox) => {
    const dir = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key];
    if (!dir || !canDraw || !onPlacePorts) return;
    e.preventDefault();
    e.stopPropagation();
    const step = PLATE_GRID * (e.shiftKey ? 4 : 1);
    const dims = { w: plate.w, h: plate.h };
    const keep = (v: number, half: number, span: number) => Math.max(half, Math.min(span - half, v));
    const cx = keep(box.x + box.w / 2 + dir[0] * step, box.w / 2, dims.w);
    const cy = keep(box.y + box.h / 2 + dir[1] * step, box.h / 2, dims.h);
    onPlacePorts(plate.chassis.id, [{ portId: box.id, ...toPlate(cx, cy, dims) }]);
  };

  const plateById = new Map(shown.map((p) => [p.chassis.id, p]));
  const cables = view.cables.flatMap((c) => {
    const ends = c.ends.filter((e): e is { portId: string; chassisId: string; rackId: string | null } => 'portId' in e);
    if (ends.length !== 2) return [];
    const [pa, pb] = [plateById.get(ends[0]!.chassisId), plateById.get(ends[1]!.chassisId)];
    if (!pa || !pb) return [];
    const [a, b] = [portCentre(pa, ends[0]!.portId), portCentre(pb, ends[1]!.portId)];
    return a && b ? [{ cable: c, a, b }] : [];
  });

  const stageW = Math.max(bounds.x + bounds.w, 1);
  const stageH = Math.max(bounds.y + bounds.h, 1);

  const handTyped = shown.filter((p) => p.chassis.model === '').map((p) => p.chassis);
  const trayTarget = !canDraw
    ? null
    : (handTyped.find((c) => selected?.kind === 'chassis' && selected.id === c.id) ?? handTyped.find((c) => c.id === deviceId) ?? handTyped[0] ?? null);

  if (!device) return <div className="jot jot--gone">That device is no longer in the design.</div>;
  const insideBody = inside && renderInsideStop ? renderInsideStop(device) : null;

  return (
    <div className="jot" ref={rootRef} data-testid="jot" onWheel={onWheel} onPointerDown={() => onSelect({ kind: 'chassis', id: deviceId })}>
      <div className="jot__bar" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" onClick={onBack}>
          ← Canvas
        </button>
        <span className="jot__name">{device.hostname || 'unnamed'}</span>
        {hoverPort !== null && <span className="jot__port">{hoverPort}</span>}
        {renderConfigDrawer && (
          <button type="button" aria-pressed={showConfig} onClick={() => setShowConfig((v) => !v)}>
            Config
          </button>
        )}
        {renderInsideStop && (
          <button type="button" aria-pressed={inside} onClick={() => setInside((v) => !v)}>
            Inside
          </button>
        )}
        {trayTarget != null && !inside && (
          <div className="jot__tray" role="group" aria-label="Add a port">
            <span className="jot__tray-label">Add port</span>
            {TRAY_CONNECTORS.map((c) => {
              const Glyph = PORT_GLYPHS[portKindFor(c) ?? 'generic'];
              return (
                <button
                  key={c}
                  type="button"
                  className="jot__tray-item"
                  draggable
                  title={`Drag onto a box, or click to add one to ${trayTarget.hostname || 'this box'}`}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(PORT_DRAG_MIME, c);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => onAddPort(trayTarget.id, c)}
                >
                  <Glyph cabled={false} />
                  <span>{connectorName(c)}</span>
                </button>
              );
            })}
          </div>
        )}
        {!inside && (
          <PlateTools
            device={device}
            canDraw={canDraw}
            canArrange={onPlacePorts !== undefined}
            arranging={arranging}
            onArrange={setArranging}
            onReset={onResetPorts ? () => onResetPorts(device.id) : undefined}
            templateOwner={templateOwner}
            onApplyTemplate={onApplyTemplate ? (ports) => onApplyTemplate(device.id, ports) : undefined}
          />
        )}
      </div>

      {insideBody != null ? (
        <div className="jot__inside">{insideBody}</div>
      ) : (
        <div
          className="jot__field"
          onDragOver={(e) => canDraw && e.preventDefault()}
          onDrop={onDrop}
          onPointerMove={moveWire}
          onPointerUp={endWire}
        >
          <div ref={stageRef} className="jot__stage" style={{ width: stageW, height: stageH, transform: `translate(${left}px, ${top}px) scale(${k})`, ['--k' as string]: k }}>

            {shown.map((plate) => (
              <Plate
                key={plate.chassis.id}
                plate={plate}
                selected={selected?.kind === 'chassis' && selected.id === plate.chassis.id}
                lit={plate.isDevice ? litPortLabel : null}
                canDraw={canDraw}
                onStartMove={startMove}
                onStartWire={startWire}
                onMoveWire={moveWire}
                onEndWire={endWire}
                onAddPort={onAddPort}
                onHoverPort={setHoverPort}
                arranging={arranging && canDraw && onPlacePorts !== undefined}
                portDrag={portDrag?.plateId === plate.chassis.id ? portDrag : null}
                onStartPortDrag={startPortDrag}
                onNudgePort={nudgePort}
              />
            ))}

            <svg className="jot__cables" width={stageW + 2000} height={stageH + 2000} style={{ left: -1000, top: -1000 }} viewBox={`-1000 -1000 ${stageW + 2000} ${stageH + 2000}`}>
              {cables.map(({ cable, a, b }) => {
                const horizontal = Math.abs(b.x - a.x) > Math.abs(b.y - a.y);
                const pull = 60;
                const d = horizontal
                  ? `M${a.x} ${a.y} C${a.x + Math.sign(b.x - a.x) * pull} ${a.y} ${b.x - Math.sign(b.x - a.x) * pull} ${b.y} ${b.x} ${b.y}`
                  : `M${a.x} ${a.y} C${a.x} ${a.y + Math.sign(b.y - a.y || 1) * pull} ${b.x} ${b.y - Math.sign(b.y - a.y || 1) * pull} ${b.x} ${b.y}`;
                const on = selected?.kind === 'cable' && selected.id === cable.id;
                return (
                  <g key={cable.id} className={on ? 'jot__cable jot__cable--on' : 'jot__cable'} data-testid="jot-cable">
                    <path d={d} className="jot__cable-hit" onPointerDown={(e) => { e.stopPropagation(); onSelect({ kind: 'cable', id: cable.id }); }} />
                    <path d={d} className="jot__cable-line" style={cable.sheath ? { stroke: SHEATH_VAR[cable.sheath] } : undefined} vectorEffect="non-scaling-stroke" />
                  </g>
                );
              })}
              {wire && <line className="jot__wire" x1={wire.a.x} y1={wire.a.y} x2={wire.to.x} y2={wire.to.y} vectorEffect="non-scaling-stroke" />}
            </svg>
          </div>
          {canDraw && shown.length === 1 && (
            <p className="jot__hint">Open Equipment on the left, then drag an item here or click it. Draw a cable from one port to another.</p>
          )}
        </div>
      )}

      {showConfig && renderConfigDrawer && <div className="jot__config">{renderConfigDrawer(device)}</div>}
    </div>
  );
}

function Plate(props: {
  plate: JotPlate;
  selected: boolean;
  lit: string | null;
  canDraw: boolean;
  onStartMove: (e: ReactPointerEvent, p: JotPlate) => void;
  onStartWire: (e: ReactPointerEvent, p: JotPlate, portId: string) => void;
  onMoveWire: (e: ReactPointerEvent) => void;
  onEndWire: (e: ReactPointerEvent) => void;
  onAddPort: (chassisId: string, connector: string) => void;
  onHoverPort: (text: string | null) => void;
  arranging: boolean;
  portDrag: PortDrag | null;
  onStartPortDrag: (e: ReactPointerEvent, p: JotPlate, box: PortBox) => void;
  onNudgePort: (e: React.KeyboardEvent, p: JotPlate, box: PortBox) => void;
}): JSX.Element {
  const { plate, selected, lit, canDraw, onStartMove, onStartWire, onMoveWire, onEndWire, onAddPort, onHoverPort, arranging, portDrag, onStartPortDrag, onNudgePort } = props;
  const byId = new Map(plate.chassis.ports.map((p) => [p.id, p]));
  const [over, setOver] = useState(false);
  const arrangeHere = arranging && plate.chassis.model === '';
  const takesPorts = canDraw && plate.chassis.model === '';
  const isPortDrag = (e: React.DragEvent) => takesPorts && e.dataTransfer.types.includes(PORT_DRAG_MIME);
  return (
    <div
      className={'jot-plate' + (plate.isDevice ? ' jot-plate--device' : '') + (selected ? ' jot-plate--selected' : '') + (over ? ' jot-plate--drop' : '') + (arrangeHere ? ' jot-plate--arranging' : '')}
      style={{ left: plate.x, top: plate.y, width: plate.w, height: plate.h }}
      data-testid={plate.isDevice ? 'jot-device' : 'jot-box'}
      onDragOver={(e) => {
        if (!isPortDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!isPortDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        onAddPort(plate.chassis.id, e.dataTransfer.getData(PORT_DRAG_MIME));
      }}
    >
      <span className="jot-plate__name" onPointerDown={(e) => onStartMove(e, plate)}>
        {plate.chassis.hostname || 'unnamed'}
        {arrangeHere && plate.chassis.ports.length > 0 && (
          <span className="jot-plate__caption">
            {' · '}
            {plate.chassis.ports.some((p) => p.face === 'front') ? 'front' : 'rear'} · drag a port to move it
          </span>
        )}
      </span>
      {portDrag?.guides.v.map((x) => <span key={`v${x}`} className="plate-guide plate-guide--v" style={{ left: x }} aria-hidden="true" />)}
      {portDrag?.guides.h.map((y) => <span key={`h${y}`} className="plate-guide plate-guide--h" style={{ top: y }} aria-hidden="true" />)}
      {portDrag &&
        (() => {
          const from = plate.layout.byId.get(portDrag.portId);
          return from ? <span className="plate-ghost" style={{ left: from.x, top: from.y, width: from.w, height: from.h }} aria-hidden="true" /> : null;
        })()}
      {plate.layout.boxes.map((box) => {
        const port = byId.get(box.id)!;
        const Glyph = PORT_GLYPHS[box.kind];
        const cabled = port.cable != null;
        const moves = arrangeHere && movable(plate, box.id);
        const dragging = portDrag?.portId === box.id;
        const left = dragging ? portDrag.px - box.w / 2 : box.x;
        const top = dragging ? portDrag.py - box.h / 2 : box.y;
        return (
          <button
            key={box.id}
            type="button"
            data-jot-port={box.id}
            title={moves ? `${port.label || 'Port'} · drag to move, or use the arrow keys` : `${port.label || 'Port'} · ${connectorName(port.connector)} · ${cabled ? 'cabled' : 'free'}`}
            className={'jot-port' + (port.label === lit ? ' jot-port--lit' : '') + (moves ? ' jot-port--movable' : '') + (dragging ? ' jot-port--dragging' : '')}
            style={{ left, top, width: box.w, height: box.h }}
            onKeyDown={moves ? (e) => onNudgePort(e, plate, box) : undefined}
            onPointerDown={(e) => (moves ? onStartPortDrag(e, plate, box) : arrangeHere ? e.stopPropagation() : onStartWire(e, plate, box.id))}
            onPointerEnter={() => onHoverPort(`${plate.chassis.hostname || 'unnamed'} · ${port.label || 'Port'} · ${connectorName(port.connector)} · ${cabled ? 'cabled' : 'free'}`)}
            onPointerLeave={() => onHoverPort(null)}
            onPointerMove={onMoveWire}
            onPointerUp={onEndWire}
          >
            <Glyph cabled={cabled} scale={plate.layout.scale} title={port.label} />
          </button>
        );
      })}
    </div>
  );
}
