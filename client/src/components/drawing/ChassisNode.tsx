import type { MouseEvent } from 'react';
import type { Node, NodeProps } from '@xyflow/react';

import { PORT_GLYPHS } from '../ports';
import type { ChassisView, PortView } from './contract';
import { U_PX } from './geometry';
import { portKindFor } from './portGlyph';

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
function PortRow({ ports, onSelectPort }: { ports: PortView[]; onSelectPort: (portId: string) => void }) {
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
        <Glyph cabled={false} title={port.label} />
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
 * is a further camera stop this component does not build). */
export function ChassisNode({ data }: NodeProps<ChassisNodeType>) {
  const { chassis, selected, portOpacity, onSelectPort } = data;
  const rows = portRows(chassis.ports);
  const height = chassis.heightU * U_PX;

  return (
    <div
      className={selected ? 'drawing-chassis drawing-chassis--selected' : 'drawing-chassis'}
      style={{ height }}
    >
      <div className="drawing-chassis__header">
        <span className="drawing-chassis__hostname">{chassis.hostname}</span>
        <span className="drawing-chassis__model">{chassis.model}</span>
      </div>
      <div className="drawing-chassis__ports" style={{ opacity: portOpacity }} aria-hidden={portOpacity === 0}>
        {rows.map((row, i) => (
          <PortRow key={i} ports={row} onSelectPort={onSelectPort} />
        ))}
      </div>
    </div>
  );
}
