import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Edge, EdgeProps } from '@xyflow/react';

import type { CableView } from './contract';
import { cableSagPath } from './geometry';
import { useLive } from './liveStore';
import { needsHairlineOutline, SHEATH_VAR } from './sheath';

export interface CableEdgeData extends Record<string, unknown> {
  cable: CableView;
  onSelect: (cableId: string) => void;
  onHoverChange: (cableId: string | null) => void;
  /** UI-SPEC "Keeping it readable at forty cables" #2: "the band opens into
   * its members with their port pairs, then folds back." Set only while
   * this cable is drawing as a fanned-out bundle member (`Drawing.tsx`);
   * `undefined` the rest of the time, when a cable draws exactly as before
   * this session. */
  portPairLabel?: string;
}

export type CableEdgeType = Edge<CableEdgeData, 'cable'>;

const STROKE_WIDTH_VAR: Record<CableView['kind'], string> = {
  copper: 'var(--cable-copper)',
  fibre: 'var(--cable-fibre)',
  power: 'var(--cable-power)',
};

/**
 * The cable itself — UI-SPEC "Cables": sag (`cableSagPath`, `geometry.ts`),
 * "colour is the real sheath," "type is the line, not the hue": copper one
 * stroke, fibre a pair with the pale core, power the heavy stroke in its
 * own lane (`cableSagPath`'s `laneBiasPx`, so a power run's curve leans the
 * opposite way from a data run's rather than sharing a line). A sheath
 * within a hairline of the page (white sheath, black sheath — `sheath.ts`)
 * draws a hairline outline first, underneath.
 *
 * Bundles (cables sharing both ends drawn as one band) and fan-on-hover
 * (the band opening to its members) are UI-SPEC "Keeping it readable at
 * forty cables" #1–2 — the next round, per the session brief. This is
 * where they attach: one `CableEdge` per physical cable today; a bundle
 * would group several `CableView`s onto one edge-shaped band here and fan
 * them out into individual `CableEdge`-shaped paths on hover, without
 * changing anything about how a single cable draws below.
 */
export function CableEdge({ sourceX, sourceY, targetX, targetY, data }: EdgeProps<CableEdgeType>) {
  // Read straight from `liveStore.ts`, so a hover never rebuilds every
  // cable's edge — ahead of the `!data` guard below so these hooks always run.
  const litCableId = useLive((s) => s.litCableId);
  const lit = useLive((s) => (data ? s.litCableIdSet.has(data.cable.id) : false));
  if (!data) return null;
  const { cable, onSelect, onHoverChange, portPairLabel } = data;
  const dimmed = litCableId != null && !lit;
  const sheath = cable.sheath ?? 'grey';
  const colour = SHEATH_VAR[sheath];
  const strokeWidth = STROKE_WIDTH_VAR[cable.kind];
  const d = cableSagPath(sourceX, sourceY, targetX, targetY, cable.kind);
  const opacity = dimmed ? 'var(--phantom)' : 1;
  const midX = (sourceX + targetX) / 2;
  const midY = (sourceY + targetY) / 2;

  function handleClick(event: ReactMouseEvent) {
    event.stopPropagation();
    onSelect(cable.id);
  }

  return (
    <g
      className="drawing-cable"
      data-cable-id={cable.id}
      style={{ opacity, cursor: 'pointer' }}
      onClick={handleClick}
      onMouseEnter={() => onHoverChange(cable.id)}
      onMouseLeave={() => onHoverChange(null)}
    >
      {lit && (
        <path
          d={d}
          fill="none"
          stroke="var(--hairline)"
          strokeWidth="var(--cable-halo)"
          strokeLinecap="round"
          className="drawing-cable__halo"
        />
      )}
      {needsHairlineOutline(sheath) && (
        <path
          d={d}
          fill="none"
          stroke="var(--hairline)"
          strokeWidth={`calc(${strokeWidth} + 2px)`}
          strokeLinecap="round"
        />
      )}
      {cable.kind === 'fibre' ? (
        <>
          <path d={d} fill="none" stroke={colour} strokeWidth={strokeWidth} strokeLinecap="round" />
          <path d={d} fill="none" stroke="var(--fibre-core)" strokeWidth="var(--fibre-core-w)" strokeLinecap="round" />
        </>
      ) : (
        <path d={d} fill="none" stroke={colour} strokeWidth={strokeWidth} strokeLinecap="round" />
      )}
      {/* A fatter, invisible stroke widens the click/hover target beyond the
          cable's own thin line — the same reasoning UI-SPEC gives a port
          glyph ("ports fade in as they become big enough to hit"), applied
          to a line rather than a box. */}
      <path d={d} fill="none" stroke="transparent" strokeWidth={12} pointerEvents="stroke" />
      {portPairLabel != null && (
        // UI-SPEC #2: "each with its own sheath and its port pair
        // labelled" — drawn only for a fanned bundle member, never for an
        // ordinary cable (`portPairLabel` is `undefined` there).
        <text x={midX} y={midY - 6} textAnchor="middle" className="drawing-cable__pair-label">
          {portPairLabel}
        </text>
      )}
    </g>
  );
}
