import type { MouseEvent } from 'react';
import { Handle, Position, useViewport, type Node, type NodeProps } from '@xyflow/react';

import { PORT_GLYPHS } from '../ports';
import { ABSENT, UNNAMED_HOSTNAME, type ChassisView, type PortView, type Sheath } from './contract';
import { PORT_ROW_GAP_PX, U_PX, counterScaledFontPx, glyphScaleFittingBudget, portRowBudgetPx } from './geometry';
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

export interface ChassisNodeData extends Record<string, unknown> {
  chassis: ChassisView;
  selected: boolean;
  /** UI-SPEC "Ports": 0 hides them entirely, 1 is fully hit-able. */
  portOpacity: number;
  onSelectPort: (portId: string) => void;
  /** Non-null while a drag-to-connect is in progress anywhere in the
   * drawing — UI-SPEC "Cables": "Only compatible ports stay live during a
   * drag; the rest dim." `fromPortId` itself is never dimmed (it is the
   * lead's fixed end); every other port dims unless `livePortIds` names it. */
  liveDrag: { fromPortId: string; livePortIds: ReadonlySet<string> } | null;
  /** UI-SPEC "Cables": "the port a cable fills takes the sheath colour."
   * `PortView.cable` (this session's contract) names *which* cable fills a
   * port, not its sheath — the sheath lives on the `CableView` the cable's
   * own edge draws from — so `Drawing.tsx` builds this lookup once from
   * `view.cables` and hands it down rather than this component reaching
   * past its own props for the cable list. */
  portSheath: ReadonlyMap<string, Sheath>;
  /** UI-SPEC "Power": "a rear-mounted chassis draws stacked beneath its
   * front neighbour... labelled rear" — `faces.ts`'s own `FaceLayoutItem.rear`,
   * passed straight through so this node never has to re-derive it from
   * `chassis.face` (which reads `rear` at the closet/rack stops' flip too,
   * a different reason for the same word). */
  rear: boolean;
}

export type ChassisNodeType = Node<ChassisNodeData, 'chassis'>;

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
  liveDrag: ChassisNodeData['liveDrag'];
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

/** The device box: name left, model right (ADR-0047 §9 — name up to two
 * thirds, model shrinks first). Only the chassis's own `face` is drawn; a
 * rear counterpart is a separate `ChassisView` the caller may or may not
 * include — this drawing does not flip it in place (UI-SPEC "Rear view"
 * is a further camera stop this component does not build).
 *
 * A freshly placed device has no hostname yet (the command that places it
 * leaves it unset until someone types one) and may carry a model the
 * catalogue does not recognise — neither is a reason for the box to go
 * blank: the model is the chassis's own field and is drawn whether or not
 * the catalogue matched it (the catalogue only adds vendor and ports, it
 * never owns the model string — see `document/view.ts`'s `chassisView`),
 * and an unset hostname reads as the muted word `UNNAMED_HOSTNAME`, never
 * blank and never invented — same rule, same word, as `Editor.tsx`. The
 * border and header row are unconditional, so an empty device still reads
 * as a device, never as a rendering failure. */
export function ChassisNode({ data }: NodeProps<ChassisNodeType>) {
  const { chassis, selected, portOpacity, onSelectPort, liveDrag, portSheath, rear } = data;
  const { zoom } = useViewport();
  const rows = portRows(chassis.ports);
  const height = chassis.heightU * U_PX;
  const hostnameFontPx = counterScaledFontPx(HOSTNAME_BASE_PX, zoom);
  const portsBudgetPx = Math.max(0, height - HEADER_MIN_PX);
  // Session 5 fix for the "1U box's port glyphs overflow its bottom edge at
  // the faceplate stop" defect (`docs/STATE.md`, carried from session 4):
  // a paired top/bottom faceplate draws two `PortRow`s sharing one box, and
  // handing each row the *whole* budget (the old code) let their combined
  // content ask for roughly double the box's real height.
  // `portRowBudgetPx` divides it first — see `geometry.ts` for the fix.
  const glyphScale = glyphScaleFittingBudget(zoom, portRowBudgetPx(portsBudgetPx, rows.length));
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
  const usage = pduUsage(chassis);

  return (
    <div
      className={selected ? 'drawing-chassis drawing-chassis--selected' : 'drawing-chassis'}
      style={{ height }}
    >
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
        {rear && <span className="drawing-chassis__rear-tag">rear</span>}
        {chassis.singleFed && (
          // UI-SPEC "Power": "single-fed... a bordered caution wash with
          // those words, the only way a risk colour appears." Never a bare
          // dot or a border alone — the word is what carries the fact.
          <span className="drawing-chassis__single-fed">single-fed</span>
        )}
        <span className="drawing-chassis__model">{usage ? pduUsageLabel(usage) : chassis.model || ABSENT}</span>
      </div>
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
      </div>
      {/* A bundle band (`bundles.ts`, `Drawing.tsx`) connects two chassis,
          not two specific ports — this invisible handle is its one shared
          anchor, positioned at the box's own left-centre by
          `.drawing-chassis__bundle-handle` (`drawing.css`) rather than any
          particular port's own absolute-positioned handle above. */}
      <Handle type="source" position={Position.Left} id="__bundle__" className="drawing-chassis__bundle-handle nodrag" />
    </div>
  );
}
