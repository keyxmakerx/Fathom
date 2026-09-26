import type { MouseEvent } from 'react';
import { Handle, Position, useViewport, type Node, type NodeProps } from '@xyflow/react';

import { C14, PORT_GLYPHS } from '../ports';
import { ABSENT, UNNAMED_HOSTNAME, type ChassisView, type InletView, type PortView, type Sheath } from './contract';
import type { Facing } from './elevation';
import { PORT_ROW_GAP_PX, U_PX, counterScaledFontPx, glyphScaleFittingBudget, portOpacity as portOpacityAt, portRowBudgetPx } from './geometry';
import { useLive } from './liveStore';
import { isPanel } from './paths';
import { portKindFor } from './portGlyph';
import { pduUsage, pduUsageLabel } from './power';
import { SHEATH_VAR } from './sheath';

/** The hostname's flow-space size at the rack stop — `drawing.css`'s own
 * 9px, kept here so `counterScaledFontPx` has a `basePx` to counter-scale
 * from. */
const HOSTNAME_BASE_PX = 9;

/** `drawing.css`'s `.drawing-chassis__header`'s own `min-height`, kept here
 * so the ports row's `glyphScaleFittingBudget` budget (whatever flow-space
 * height is left after the header) matches the CSS it is actually
 * competing with for a 1U row's 16 flow px. */
const HEADER_MIN_PX = 9;

/** A rear-elevation power lead's stable handle at the closet and rack
 * stops — `docs/decisions/adr-0050-the-rear-elevation.md` §1. `InletStrip`
 * (below) only mounts its own per-inlet handles when it actually draws —
 * `showInletStrip`, tied to this node's own `elevation` prop — so a lead
 * whose far node flips elevation the same render loses its handle for the
 * one frame between that mount and React Flow's own measurement of it
 * (`Drawing.tsx`'s `resolveEnd` routes here instead at those two stops, the
 * faceplate stop's own zoomed-in read still landing on the inlet itself).
 * One per chassis, not per inlet — "the plate's inlet-end edge (the same
 * side the strip sits on)," never a specific inlet's own position — so the
 * id is a plain constant, exactly like `__bundle__` below. */
export const INLET_ANCHOR_HANDLE_ID = '__inlet-anchor__';

export interface ChassisNodeData extends Record<string, unknown> {
  chassis: ChassisView;
  /** This elevation's own faceplate ports (`elevation.ts`'s `faceplateItem`
   * — ADR-0050 §1) — never `chassis.ports` directly, which now carries both
   * faceplates' ports at once (this session's contract). */
  ports: PortView[];
  /** This elevation's own inlets, same filtering as `ports` — drawn in the
   * inlet strip only when `elevation === 'rear'` (`elevation` below); the
   * front elevation's inlets still end their power lead on the rack's own
   * rail hexagon (`RackNode.tsx`), "as today," so this node leaves them off
   * the faceplate there rather than drawing them twice. */
  inlets: InletView[];
  /** ADR-0050 §1: which elevation this chassis is currently drawn in —
   * decides whether the inlet strip draws at all (rear only) and is shown
   * so a caller can tell "rear" apart from "this chassis's own rear-mounted
   * fact," a different reason for the same word. */
  elevation: Facing;
  onSelectPort: (portId: string) => void;
  /** UI-SPEC "Cables": "the port a cable fills takes the sheath colour."
   * `PortView.cable` (this session's contract) names *which* cable fills a
   * port, not its sheath — the sheath lives on the `CableView` the cable's
   * own edge draws from — so `Drawing.tsx` builds this lookup once from
   * `view.cables` and hands it down rather than this component reaching
   * past its own props for the cable list. */
  portSheath: ReadonlyMap<string, Sheath>;
}

/** GitHub issue #66: `selected`, `portOpacity`, `liveDrag` and `litCableId`
 * used to live on `ChassisNodeData` above, which meant a hover, a zoom tick
 * or a drag-to-connect anywhere in the drawing rebuilt THIS chassis's own
 * node object too, on every one of those renders, whether or not this
 * particular chassis was involved — and React Flow drops a node's measured
 * size whenever its node object changes. They now live in `liveStore.ts`'s
 * small external store, read here with `useLive`'s own selector so this
 * component re-renders on its own, without needing a new `data` object from
 * `Drawing.tsx` at all. `portOpacity` is zoom-derived, so it is read
 * straight off React Flow's own `useViewport` instead — the same "the
 * store nodes already subscribe to" reading, just React Flow's own rather
 * than a new one. */
function useChassisLiveData(chassisId: string, zoomPercent: number) {
  const selected = useLive((s) => s.selected?.kind === 'chassis' && s.selected.id === chassisId);
  const litCableId = useLive((s) => s.litCableId);
  const dragFromPortId = useLive((s) => s.dragFromPortId);
  const livePortIds = useLive((s) => s.livePortIds);
  const dimmed = useLive((s) => s.dimmedChassisId === chassisId);
  const liveDrag = dragFromPortId != null ? { fromPortId: dragFromPortId, livePortIds } : null;
  return { selected, litCableId, liveDrag, dimmed, portOpacity: portOpacityAt(zoomPercent) };
}

export type ChassisNodeType = Node<ChassisNodeData, 'chassis'>;

/** UI-SPEC "Cables": "Only compatible ports stay live during a drag; the
 * rest dim." `fromPortId` itself is never dimmed (it is the lead's fixed
 * end); every other port dims unless `livePortIds` names it. Read from
 * `liveStore.ts` now (`useChassisLiveData`, below), not `data` — see that
 * function's own doc. */
export type LiveDrag = { fromPortId: string; livePortIds: ReadonlySet<string> } | null;

function portRows(ports: PortView[]): PortView[][] {
  const byRow = new Map<number, PortView[]>();
  for (const port of ports) {
    const row = byRow.get(port.row) ?? [];
    row.push(port);
    byRow.set(port.row, row);
  }
  return [...byRow.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, row]) => [...row].sort((a, b) => a.column - b.column));
}

/** One port row: non-uplink ports left, uplink ports right — UI-SPEC "Ports":
 * "uplinks right." Each glyph carries its own React Flow `Handle` (loose
 * connection mode, `Drawing.tsx`) so a drag can start or land on any port;
 * the glyph itself still carries the click that selects it. */
function PortRow({
  ports,
  onSelectPort,
  glyphScale,
  liveDrag,
  portSheath,
}: {
  ports: PortView[];
  onSelectPort: (portId: string) => void;
  /** `glyphScaleFittingBudget`'s flow-space multiplier, so a port glyph
   * reads at its true size on screen (`components/ports`'s own contract)
   * rather than growing with the camera the way the rest of a flow-space
   * node does — shrunk below true size only if the row does not have room
   * for it. */
  glyphScale: number;
  liveDrag: LiveDrag;
  portSheath: ChassisNodeData['portSheath'];
}) {
  function glyph(port: PortView) {
    const kind = portKindFor(port.connector);
    if (kind == null) return null;
    const Glyph = PORT_GLYPHS[kind];
    const cable = port.cable ?? null;
    const cabled = cable != null;
    const sheath = cabled ? portSheath.get(port.id) : undefined;

    const isOrigin = liveDrag?.fromPortId === port.id;
    const isLive = isOrigin || (liveDrag != null && liveDrag.livePortIds.has(port.id));
    const dimmed = liveDrag != null && !isLive;

    const style: Record<string, string | number> = {};
    if (dimmed) style.opacity = 'var(--phantom)';
    // UI-SPEC "Cables": "the port a cable fills takes the sheath colour" —
    // `--port-sheath` is read by `drawing.css`'s
    // `.drawing-chassis__port--cabled .port--cabled .port__body` rule,
    // three classes deep so it outranks `ports.css`'s own two-class
    // `.port--cabled .port__body { fill: var(--ink) }` regardless of which
    // stylesheet's rule happens to load last (`components/ports/index.ts`
    // imports `ports.css` on the drawing's own first render, so load order
    // is not something this component can rely on).
    if (sheath != null) style['--port-sheath'] = SHEATH_VAR[sheath];

    return (
      <button
        key={port.id}
        type="button"
        data-port-id={port.id}
        className={
          cabled ? 'drawing-chassis__port drawing-chassis__port--cabled nodrag' : 'drawing-chassis__port nodrag'
        }
        style={style}
        onClick={(event: MouseEvent) => {
          event.stopPropagation();
          onSelectPort(port.id);
        }}
      >
        <Glyph cabled={cabled} title={port.label} scale={glyphScale} />
        {/* UI-SPEC "One cable per port": an already-cabled port is never a
            target — `isConnectable={false}` keeps it from both starting a
            second lead and accepting one. `type="source"`, not meaningful
            on its own: `Drawing.tsx` sets `connectionMode="loose"` so any
            handle can both start and receive a drag. */}
        <Handle
          type="source"
          position={Position.Right}
          id={port.id}
          isConnectable={!cabled}
          className="drawing-chassis__port-handle"
        />
      </button>
    );
  }

  const downlink = ports.filter((p) => !p.uplink);
  const uplink = ports.filter((p) => p.uplink);
  return (
    <div className="drawing-chassis__port-row">
      <div className="drawing-chassis__port-group">{downlink.map(glyph)}</div>
      <div className="drawing-chassis__port-group drawing-chassis__port-group--uplink">{uplink.map(glyph)}</div>
    </div>
  );
}

/** ADR-0050 §1/§3: one PSU inlet, drawn like a faceplate port (not a rail
 * hexagon — that stays the front elevation's own shorthand, `RackNode.tsx`)
 * at its own position, in one of three states the C14 glyph alone cannot
 * tell apart on its own two props (`cabled`): filled when a supply is
 * fitted and cabled, hollow when fitted and uncabled (`C14`'s own
 * `cabled={false}` already draws hollow — the plain "free" reading a
 * faceplate port already has), and — an inlet with no supply behind it at
 * all, which is neither — a dashed empty outline, a state no other port on
 * this drawing needs, so it is the one added here via `className` (a prop
 * `C14`/`components/ports` already accepts) rather than a change to that
 * shared component. */
function InletGlyph({
  inlet,
  onSelectPort,
  glyphScale,
  litCableId,
}: {
  inlet: InletView;
  onSelectPort: (portId: string) => void;
  glyphScale: number;
  /** s6f #2: "the same hover key" the rail hexagon that stands for this
   * inlet shares (`RackNodeData.onHoverInlet`) — dims this glyph exactly
   * like `PortRow`'s own `liveDrag`-driven dimming does, when something is
   * lit and it is not this inlet's own cable. */
  litCableId: string | null;
}) {
  const cabled = inlet.cable != null;
  const title = `${inlet.slot || inlet.label} — ${inlet.fitted ? (cabled ? 'fed' : 'fitted, no lead') : 'not fitted'}`;
  const dimmed = litCableId != null && inlet.cable?.cableId !== litCableId;
  const style: Record<string, string | number> = {};
  if (dimmed) style.opacity = 'var(--phantom)';
  return (
    <button
      key={inlet.id}
      type="button"
      data-port-id={inlet.id}
      className={
        cabled ? 'drawing-chassis__port drawing-chassis__port--cabled nodrag' : 'drawing-chassis__port nodrag'
      }
      style={style}
      onClick={(event: MouseEvent) => {
        event.stopPropagation();
        onSelectPort(inlet.id);
      }}
    >
      <C14 cabled={cabled} title={title} scale={glyphScale} className={inlet.fitted ? undefined : 'drawing-chassis__inlet--unfitted'} />
      <Handle
        type="source"
        position={Position.Right}
        id={inlet.id}
        isConnectable={inlet.fitted && !cabled}
        className="drawing-chassis__port-handle"
      />
    </button>
  );
}

/** The inlet strip — ADR-0050 §1: "at their position in an inlet strip at
 * the plate's end." Grouped top/bottom the same way `PortRow` groups a
 * faceplate's own rows (`InletView.position.row`), right-aligned like an
 * uplink group so it reads as the plate's trailing edge regardless of how
 * many ordinary ports sit before it. */
function InletStrip({
  inlets,
  onSelectPort,
  glyphScale,
  litCableId,
}: {
  inlets: InletView[];
  onSelectPort: (portId: string) => void;
  glyphScale: number;
  litCableId: string | null;
}) {
  const byRow = new Map<string, InletView[]>();
  for (const inlet of inlets) {
    const key = inlet.position?.row ?? 'single';
    const row = byRow.get(key) ?? [];
    row.push(inlet);
    byRow.set(key, row);
  }
  const rows = [...byRow.entries()].sort(([a], [b]) => (a === 'top' ? -1 : a === b ? 0 : 1));
  return (
    <div className="drawing-chassis__inlets">
      {rows.map(([rowKey, rowInlets]) => (
        <div key={rowKey} className="drawing-chassis__port-row">
          <div className="drawing-chassis__port-group drawing-chassis__port-group--uplink">
            {[...rowInlets]
              .sort((a, b) => (a.position?.column ?? 0) - (b.position?.column ?? 0))
              .map((inlet) => (
                <InletGlyph key={inlet.id} inlet={inlet} onSelectPort={onSelectPort} glyphScale={glyphScale} litCableId={litCableId} />
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The device box: name left, model right (ADR-0047 §9 — name up to two
 * thirds, model shrinks first). ADR-0050 §1: draws whichever faceplate
 * (`ports`/`inlets`, already resolved for `elevation` by `Drawing.tsx` via
 * `elevation.ts`) faces the current elevation — never the chassis's own
 * mounting face directly. A face with neither ports nor inlets draws as a
 * plain plate: the header (and so the chassis's name) is unconditional, so
 * an empty faceplate still reads as a device, never as a rendering failure —
 * "never nothing."
 *
 * A freshly placed device has no hostname yet (the command that places it
 * leaves it unset until someone types one) and may carry a model the
 * catalogue does not recognise — neither is a reason for the box to go
 * blank: the model is the chassis's own field and is drawn whether or not
 * the catalogue matched it (the catalogue only adds vendor and ports, it
 * never owns the model string — see `document/view.ts`'s `chassisView`),
 * and an unset hostname reads as the muted word `UNNAMED_HOSTNAME`, never
 * blank and never invented — same rule, same word, as `Editor.tsx`. */
export function ChassisNode({ data }: NodeProps<ChassisNodeType>) {
  const { chassis, ports, inlets, elevation, onSelectPort, portSheath } = data;
  const { zoom } = useViewport();
  const { selected, litCableId, liveDrag, dimmed, portOpacity } = useChassisLiveData(chassis.id, zoom * 100);
  const rows = portRows(ports);
  const height = chassis.heightU * U_PX;
  const hostnameFontPx = counterScaledFontPx(HOSTNAME_BASE_PX, zoom);
  const portsBudgetPx = Math.max(0, height - HEADER_MIN_PX);
  // Session 5 fix for the "1U box's port glyphs overflow its bottom edge at
  // the faceplate stop" defect (`docs/STATE.md`, carried from session 4):
  // a paired top/bottom faceplate draws two `PortRow`s sharing one box, and
  // handing each row the *whole* budget (the old code) let their combined
  // content ask for roughly double the box's real height.
  // `portRowBudgetPx` divides it first — see `geometry.ts` for the fix.
  // ADR-0050 §1: the rear elevation's inlet strip is one more row sharing
  // that same budget, on top of whatever ordinary port rows this face has.
  const showInletStrip = elevation === 'rear' && inlets.length > 0;
  const inletRowCount = showInletStrip ? new Set(inlets.map((i) => i.position?.row ?? 'single')).size : 0;
  const glyphScale = glyphScaleFittingBudget(zoom, portRowBudgetPx(portsBudgetPx, rows.length + inletRowCount));
  const hasHostname = chassis.hostname.length > 0;
  // UI-SPEC "Keeping it readable" / "Power": an unpowered chassis (no PSU
  // inlet the catalogue knows of — `paths.ts`'s own `isPanel`, its file
  // header records why this is the reading this session settled on) draws
  // without the "live device" bullet, matching `Main.dc.html`'s own
  // patch-01/fibre-01/pdu-a04 rows — the only three boxes on that board
  // with neither a bullet nor a PSU mark on the rail beside them.
  const passive = isPanel(chassis);
  // UI-SPEC "Power": "A PDU's outlets are its C13 faceplate ports and its
  // header shows `n of m used`, derived" — takes the model text's own slot
  // when this chassis is one; an ordinary device (or panel) keeps the model.
  // Read off this elevation's own `ports` (not `chassis.ports`, both faces
  // at once): a PDU's outlets are on one faceplate, and the header should
  // count only what this face actually shows.
  const usage = pduUsage({ ports });
  const plainPlate = ports.length === 0 && inlets.length === 0;

  const className = [
    'drawing-chassis',
    selected ? 'drawing-chassis--selected' : '',
    // s6g #1, UI-SPEC "Config": "Plate stays above, dimmed" — `dimmed`
    // (`useChassisLiveData`, above) is the selected chassis while its
    // config drawer is open; this used to be a `Node`-level `className`
    // `Drawing.tsx` set on the wrapping `.react-flow__node` element
    // itself (`drawing.css`'s own `.drawing-chassis-node--dimmed` targets
    // whatever element carries it directly, not a descendant), so applying
    // it to this component's own root reads the same class the same way.
    dimmed ? 'drawing-chassis-node--dimmed' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className} style={{ height }}>
      <div className="drawing-chassis__header">
        {!passive && <span className="drawing-chassis__bullet" aria-hidden="true" />}
        <span
          className={
            hasHostname
              ? 'drawing-chassis__hostname'
              : 'drawing-chassis__hostname drawing-chassis__hostname--placeholder'
          }
          style={{ fontSize: hostnameFontPx }}
        >
          {hasHostname ? chassis.hostname : UNNAMED_HOSTNAME}
        </span>
        {chassis.singleFed && (
          // UI-SPEC "Power": "single-fed... a bordered caution wash with
          // those words, the only way a risk colour appears." Never a bare
          // dot or a border alone — the word is what carries the fact.
          <span className="drawing-chassis__single-fed">single-fed</span>
        )}
        {chassis.oneFitted && (
          // ADR-0050 §4: "a second wash — one fitted — joins it." A
          // distinct mark from `singleFed`: a slot can sit empty whether or
          // not the inlets that remain are themselves short of a feed.
          <span className="drawing-chassis__one-fitted">one fitted</span>
        )}
        {!plainPlate && <span className="drawing-chassis__model">{usage ? pduUsageLabel(usage) : chassis.model || ABSENT}</span>}
      </div>
      {!plainPlate && (
        <div
          className="drawing-chassis__ports"
          style={{ opacity: portOpacity, gap: PORT_ROW_GAP_PX }}
          aria-hidden={portOpacity === 0}
        >
          {rows.map((row, i) => (
            <PortRow
              key={i}
              ports={row}
              onSelectPort={onSelectPort}
              glyphScale={glyphScale}
              liveDrag={liveDrag}
              portSheath={portSheath}
            />
          ))}
          {showInletStrip && (
            <InletStrip inlets={inlets} onSelectPort={onSelectPort} glyphScale={glyphScale} litCableId={litCableId} />
          )}
        </div>
      )}
      {/* A bundle band (`bundles.ts`, `Drawing.tsx`) connects two chassis,
          not two specific ports — this invisible handle is its one shared
          anchor, positioned at the box's own left-centre by
          `.drawing-chassis__bundle-handle` (`drawing.css`) rather than any
          particular port's own absolute-positioned handle above. */}
      <Handle type="source" position={Position.Left} id="__bundle__" className="drawing-chassis__bundle-handle nodrag" />
      {/* s6f #1: the rear elevation's stable inlet-end anchor — see
          `INLET_ANCHOR_HANDLE_ID`'s own doc above. Rendered unconditionally
          (not gated on `showInletStrip`/`plainPlate`) whenever this chassis
          draws in the rear elevation, so it is never subject to the same
          mount-then-measure gap the strip's own per-inlet handles are. */}
      {elevation === 'rear' && (
        <Handle
          type="source"
          position={Position.Right}
          id={INLET_ANCHOR_HANDLE_ID}
          isConnectable={false}
          className="drawing-chassis__inlet-anchor-handle nodrag"
        />
      )}
    </div>
  );
}
