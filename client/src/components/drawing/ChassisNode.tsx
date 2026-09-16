import type { MouseEvent } from 'react';
import { useViewport, type Node, type NodeProps } from '@xyflow/react';

import { PORT_GLYPHS } from '../ports';
import { ABSENT, UNNAMED_HOSTNAME, type ChassisView, type PortView } from './contract';
import { U_PX, counterScaledFontPx, glyphScaleFittingBudget } from './geometry';
import { portKindFor } from './portGlyph';

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
 * "uplinks right." No cable state travels on `PortView` yet (the contract
 * carries no `cabled` field), so every glyph draws hollow — UI-SPEC "Absent
 * is drawn as absent," never invented as cabled or free. */
function PortRow({
  ports,
  onSelectPort,
  glyphScale,
}: {
  ports: PortView[];
  onSelectPort: (portId: string) => void;
  /** `glyphScaleFittingBudget`'s flow-space multiplier, so a port glyph
   * reads at its true size on screen (`components/ports`'s own contract)
   * rather than growing with the camera the way the rest of a flow-space
   * node does — shrunk below true size only if the row does not have room
   * for it. */
  glyphScale: number;
}) {
  function glyph(port: PortView) {
    const kind = portKindFor(port.connector);
    if (kind == null) return null;
    const Glyph = PORT_GLYPHS[kind];
    return (
      <button
        key={port.id}
        type="button"
        className="drawing-chassis__port nodrag"
        onClick={(event: MouseEvent) => {
          event.stopPropagation();
          onSelectPort(port.id);
        }}
      >
        <Glyph cabled={false} title={port.label} scale={glyphScale} />
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
  const { chassis, selected, portOpacity, onSelectPort } = data;
  const { zoom } = useViewport();
  const rows = portRows(chassis.ports);
  const height = chassis.heightU * U_PX;
  const hostnameFontPx = counterScaledFontPx(HOSTNAME_BASE_PX, zoom);
  const portsBudgetPx = Math.max(0, height - HEADER_MIN_PX);
  const glyphScale = glyphScaleFittingBudget(zoom, portsBudgetPx);
  const hasHostname = chassis.hostname.length > 0;

  return (
    <div
      className={selected ? 'drawing-chassis drawing-chassis--selected' : 'drawing-chassis'}
      style={{ height }}
    >
      <div className="drawing-chassis__header">
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
        <span className="drawing-chassis__model">{chassis.model || ABSENT}</span>
      </div>
      <div className="drawing-chassis__ports" style={{ opacity: portOpacity }} aria-hidden={portOpacity === 0}>
        {rows.map((row, i) => (
          <PortRow key={i} ports={row} onSelectPort={onSelectPort} glyphScale={glyphScale} />
        ))}
      </div>
    </div>
  );
}
